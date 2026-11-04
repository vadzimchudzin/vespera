"use strict";

/* Collector storage: one brotli-compressed JSONL file per stream and UTC hour, compressed while it is written and
 * flushed every second, so a crash loses at most about a second and no hour ever sits uncompressed on disk.
 *   <dir>/<YYYY-MM-DD>/<stream>-<HH>[-<n>].jsonl.br.part   the hour being written (-2, -3 … after a restart in the hour)
 *   <dir>/<YYYY-MM-DD>/<stream>-<HH>[-<n>].jsonl.br        a finished hour
 *   <dir>/<YYYY-MM-DD>/manifest.json                       per file: lines, first/last receipt time, raw and compressed
 *                                                          bytes, sha256 of the file; the day's gaps; endpoints used
 * A line is {"rt": receipt time in ms, "d": the message}. Stream names are lower-case letters and dashes.
 * Finishing an hour: end the stream → fsync → rename .part away → manifest entry (written atomically).
 * A crash leaves a .part behind: open() keeps every whole line in it and finishes it as a recovered file.
 * Brotli (quality 5) is about half the size of gzip on these streams at the same speed; read files with
 * `brotli -dc`, Python's brotli or Node's zlib.createBrotliDecompress. */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STREAM_RE = /^[a-z](?:[a-z-]*[a-z])?$/;
const FILE_RE = /^([a-z](?:[a-z-]*[a-z])?)-(\d{2})(?:-(\d+))?\.jsonl\.br(\.part)?$/;
const EXT = ".jsonl.br";
const PART = ".part";
const MANIFEST = "manifest.json";
const MAX_GAPS = 20000;
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } };

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const utcHour = (t) => new Date(t).getUTCHours();
const hh = (h) => String(h).padStart(2, "0");
const parseName = (name) => {
  const m = FILE_RE.exec(name);
  return m ? { stream: m[1], hour: Number(m[2]), part: m[3] ? Number(m[3]) : 1, open: !!m[4] } : null;
};

function fsyncPath(file) {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o640);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const tap = (onChunk) => new Transform({ transform(chunk, _enc, done) { onChunk(chunk); done(null, chunk); } });

// Every line of a .jsonl.br(.part) file: onLine(record) for each valid one. Returns the line count, lines that are not
// {"rt","d"} JSON, the first and last receipt time, the sha256 and size of the file, and a decoding error if any
// (expected for a .part: it ends wherever the writer was).
async function scanFile(file, onLine = null) {
  const hash = crypto.createHash("sha256");
  let bytes = 0, lines = 0, bad = 0, first = null, last = null, error = null;
  const input = fs.createReadStream(file), decode = zlib.createBrotliDecompress();
  decode.on("error", (e) => { error = error || e; });
  input.on("error", (e) => { error = error || e; decode.destroy(e); });
  const rl = readline.createInterface({ input: input.pipe(tap((c) => { hash.update(c); bytes += c.length; })).pipe(decode), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      lines += 1;
      let rec = null;
      try { rec = JSON.parse(line); } catch { rec = null; }
      if (!rec || typeof rec !== "object" || !Number.isFinite(rec.rt) || !("d" in rec)) { bad += 1; continue; }
      if (first == null) first = rec.rt;
      last = rec.rt;
      if (onLine) onLine(rec);
    }
  } catch (e) {
    error = error || e;
  }
  return { lines, bad, first, last, sha256: hash.digest("hex"), bytes, error: error ? error.code || error.message || "decode_failed" : null };
}

class Store {
  constructor({ dir, log = () => {} }) {
    if (!dir) throw new Error("collector_dir_missing");
    this.dir = path.resolve(dir);
    this.log = log;
    this.files = new Map();       // stream → the file being written
    this.manifests = new Map();   // day → manifest
    this.jobs = new Set();        // files being finished
    this.errors = 0;
    this.lastError = null;
    this.written = {};            // stream → lines since start
    this.closed = false;
  }

  dayDir(day) { return path.join(this.dir, day); }

  // Finishes what a crash left behind (.part files), removes stray .tmp files, enters finished files missing from
  // their manifest again. Then the store is ready to write.
  async open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    const jobs = [];
    for (const day of fs.readdirSync(this.dir).filter((d) => DAY_RE.test(d)).sort()) {
      const ddir = this.dayDir(day);
      if (!fs.statSync(ddir).isDirectory()) continue;
      const names = fs.readdirSync(ddir);
      const manifest = this._manifest(day);
      for (const name of names) {
        const full = path.join(ddir, name);
        if (name.endsWith(".tmp")) { fs.rmSync(full, { force: true }); continue; }
        const info = parseName(name);
        if (!info) continue;
        if (info.open) jobs.push(this._track(this._recover(day, name.slice(0, -PART.length), info)));
        else if (!manifest.files[name]) jobs.push(this._track(this._index(day, name, info)));
      }
    }
    await Promise.all(jobs);
    return this;
  }

  write(stream, rt, d) { return this._line(stream, rt, `${JSON.stringify({ rt, d })}\n`); }

  // The message is already JSON text (the CLOB stream is stored without a parse/stringify round trip).
  writeRaw(stream, rt, json) { return this._line(stream, rt, `{"rt":${rt},"d":${json}}\n`); }

  // Once a second: compressed buffers out to the file; hours that are over are finished even if their stream is quiet.
  tick(now) {
    const day = utcDay(now), hour = utcHour(now);
    for (const f of [...this.files.values()]) {
      if (f.day !== day || f.hour !== hour) this._close(f);
      else if (f.dirty) { f.dirty = false; f.enc.flush(zlib.constants.BROTLI_OPERATION_FLUSH); }
    }
  }

  async close() {
    this.closed = true;
    for (const f of [...this.files.values()]) this._close(f);
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  // A gap goes into the manifest of every day it touches.
  addGap(gap) {
    for (let t = Date.parse(`${utcDay(gap.from)}T00:00:00Z`); t <= gap.to; t += 86400000) {
      this._update(utcDay(t), (m) => {
        if (m.gaps.length < MAX_GAPS) m.gaps.push(gap);
        else m.gapsDropped = (m.gapsDropped || 0) + 1;
      });
    }
  }

  // Which endpoint served a source on a day (Binance can fall back to another).
  noteEndpoint(day, source, endpoint) {
    const m = this._manifest(day);
    if ((m.endpoints[source] || []).includes(endpoint)) return;
    this._update(day, (x) => { x.endpoints[source] = [...(x.endpoints[source] || []), endpoint]; });
  }

  status() {
    const open = {};
    for (const [stream, f] of this.files) open[stream] = { file: path.join(f.day, f.name), lines: f.lines, raw: f.raw, bytes: f.bytes };
    return { dir: this.dir, open, finishing: this.jobs.size, errors: this.errors, lastError: this.lastError, written: { ...this.written } };
  }

  _error(code, e) {
    this.errors += 1;
    this.lastError = `${code}: ${(e && (e.code || e.message)) || e}`;
    this.log("error", this.lastError);
  }

  _track(run) {
    this.jobs.add(run);
    run.finally(() => this.jobs.delete(run));
    return run;
  }

  _line(stream, rt, line) {
    if (this.closed) return false;
    let f = this.files.get(stream);
    const day = utcDay(rt), hour = utcHour(rt);
    if (f && (f.day !== day || f.hour !== hour)) { this._close(f); f = null; }
    if (!f) f = this._start(stream, day, hour);
    if (!f) return false;
    f.enc.write(line);
    f.dirty = true;
    f.lines += 1;
    f.raw += Buffer.byteLength(line);
    if (f.first == null) f.first = rt;
    f.last = rt;
    this.written[stream] = (this.written[stream] || 0) + 1;
    return true;
  }

  _start(stream, day, hour) {
    if (!STREAM_RE.test(stream)) throw new Error(`collector_stream_invalid: ${stream}`);
    const ddir = this.dayDir(day);
    try {
      fs.mkdirSync(ddir, { recursive: true, mode: 0o750 });
      const manifest = this._manifest(day);
      let part = 1, name;
      for (;;) {
        name = `${stream}-${hh(hour)}${part > 1 ? `-${part}` : ""}${EXT}`;
        if (!manifest.files[name] && !fs.existsSync(path.join(ddir, name)) && !fs.existsSync(path.join(ddir, name + PART))) break;
        part += 1;
      }
      const full = path.join(ddir, name), tmp = full + PART, hash = crypto.createHash("sha256");
      const f = { stream, day, hour, part, name, full, tmp, hash, lines: 0, raw: 0, bytes: 0, first: null, last: null, dirty: false };
      f.enc = zlib.createBrotliCompress(BROTLI);
      f.done = pipeline(f.enc, tap((c) => { hash.update(c); f.bytes += c.length; }), fs.createWriteStream(tmp, { flags: "wx", mode: 0o640 }));
      f.done.catch(() => {});
      this.files.set(stream, f);
      return f;
    } catch (e) {
      this._error("collector_open_failed", e);
      return null;
    }
  }

  _close(f) {
    this.files.delete(f.stream);
    f.enc.end();
    this._track((async () => {
      try {
        await f.done;
        fsyncPath(f.tmp);
        fs.renameSync(f.tmp, f.full);
        const entry = { stream: f.stream, hour: f.hour, part: f.part, lines: f.lines, first: f.first, last: f.last, raw: f.raw, bytes: f.bytes, sha256: f.hash.digest("hex") };
        this._update(f.day, (m) => { m.files[f.name] = entry; });
      } catch (e) {
        this._error("collector_finish_failed", e);   // the .part stays and is recovered at the next start
      }
    })());
  }

  // A .part from a crash: if it decodes to the end it is complete and only renamed; otherwise its whole lines are
  // compressed into the finished file and the torn tail is dropped.
  async _recover(day, name, info) {
    const full = path.join(this.dayDir(day), name), part = full + PART;
    try {
      const scan = await scanFile(part);
      let entry;
      if (!scan.error && !scan.bad) {
        fsyncPath(part);
        fs.renameSync(part, full);
        entry = { lines: scan.lines, first: scan.first, last: scan.last, raw: null, bytes: scan.bytes, sha256: scan.sha256, recovered: true };
      } else {
        const tmp = `${full}.tmp`, hash = crypto.createHash("sha256"), enc = zlib.createBrotliCompress(BROTLI);
        let bytes = 0, raw = 0;
        const done = pipeline(enc, tap((c) => { hash.update(c); bytes += c.length; }), fs.createWriteStream(tmp, { mode: 0o640 }));
        const kept = await scanFile(part, (rec) => { const line = `${JSON.stringify(rec)}\n`; raw += Buffer.byteLength(line); enc.write(line); });
        enc.end();
        await done;
        fsyncPath(tmp);
        fs.renameSync(tmp, full);
        fs.rmSync(part, { force: true });
        entry = { lines: kept.lines - kept.bad, first: kept.first, last: kept.last, raw, bytes, sha256: hash.digest("hex"), recovered: true,
          droppedLines: kept.bad, torn: kept.error || null };
      }
      if (!entry.lines) { fs.rmSync(full, { force: true }); return; }
      this._update(day, (m) => { m.files[name] = { stream: info.stream, hour: info.hour, part: info.part, ...entry }; });
    } catch (e) {
      this._error("collector_recover_failed", e);
    }
  }

  async _index(day, name, info) {
    try {
      const scan = await scanFile(path.join(this.dayDir(day), name));
      if (scan.error) throw new Error(scan.error);
      this._update(day, (m) => {
        m.files[name] = { stream: info.stream, hour: info.hour, part: info.part, lines: scan.lines, first: scan.first, last: scan.last, raw: null, bytes: scan.bytes,
          sha256: scan.sha256, recovered: true, badLines: scan.bad };
      });
    } catch (e) {
      this._error("collector_index_failed", e);
    }
  }

  _manifest(day) {
    let m = this.manifests.get(day);
    if (m) return m;
    const file = path.join(this.dayDir(day), MANIFEST);
    try {
      m = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!m || typeof m !== "object" || !m.files || typeof m.files !== "object") throw new Error("manifest_invalid");
      m.gaps = Array.isArray(m.gaps) ? m.gaps : [];
      m.endpoints = m.endpoints && typeof m.endpoints === "object" ? m.endpoints : {};
    } catch (e) {
      if (e.code !== "ENOENT") {
        try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch {}
        this._error("collector_manifest_unreadable", e);
      }
      m = { version: 1, day, files: {}, gaps: [], endpoints: {} };
    }
    this.manifests.set(day, m);
    return m;
  }

  _update(day, change) {
    const m = this._manifest(day);
    change(m);
    m.updated = Date.now();
    try {
      fs.mkdirSync(this.dayDir(day), { recursive: true, mode: 0o750 });
      writeAtomic(path.join(this.dayDir(day), MANIFEST), `${JSON.stringify(m, null, 1)}\n`);
    } catch (e) {
      this._error("collector_manifest_write_failed", e);
    }
  }
}

module.exports = { Store, scanFile, parseName, utcDay, utcHour, MANIFEST, DAY_RE, EXT, PART };
