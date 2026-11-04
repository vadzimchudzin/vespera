"use strict";

/* `collect check <day>`: is a day of data whole, and do the results rebuilt from it match Polymarket's?
 *  1. files: every manifest entry exists with its sha256, line count and first/last receipt time, every line is JSON;
 *     files the manifest does not know are listed (a .part is an hour still being written, or one a crash left for
 *     the next start to finish; it is read as far as it goes)
 *  2. gaps per feed: count, total, longest, how many over gapMs; a Chainlink gap that the history asked after the
 *     reconnect filled (a TWAP-60 point for every asset in every second of it) is listed as filled, not over
 *  3. results of the windows that ended that day (UTC), rebuilt by their rule (see windows.js):
 *       chainlink-twap60  TWAP-60 at the end second ≥ TWAP-60 at the start second → Up
 *       binance-1h        last trade of the hour ≥ first trade of the hour → Up
 *       binance-1m-close  last trade in the minute after the end vs in the minute after the start (equal → 50-50)
 *     A Binance price at a boundary needs trades recorded on both sides of it (within 10 s).
 *     against the official result, and the start/end values against Gamma's priceToBeat/finalPrice where given.
 *     A Binance value next to a gap, or from Binance.US, is "unsure"; a missing value is "no data". */
const fs = require("node:fs");
const path = require("node:path");
const { scanFile, parseName, utcDay, utcHour, MANIFEST, DAY_RE } = require("./store");

const DAY_MS = 86400000;
const MIN_MS = 60000;
const PROOF_MS = 10000;
const dayOf = (day, delta) => utcDay(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);
const close = (a, b) => a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

function readManifest(ddir) {
  try { return JSON.parse(fs.readFileSync(path.join(ddir, MANIFEST), "utf8")); } catch (e) { return e.code === "ENOENT" ? null : { broken: e.message }; }
}

// What the result rebuild needs, gathered while the files are read: TWAP-60 points, Binance trades per minute, windows.
class Index {
  constructor() {
    this.twap = new Map();       // "btc/usd" → Map(ms → value)
    this.minutes = new Map();    // "binance|BTCUSDT" → Map(minute → {fT, fA, fP, lT, lA, lP})
    this.windows = new Map();    // slug → latest window record
    this.windowAt = new Map();
  }

  visitor(stream) {
    if (stream === "chainlink") return (rec) => this._chainlink(rec.d);
    if (stream === "binance" || stream === "binanceus") return (rec) => this._trade(stream, rec.d);
    if (stream === "meta") return (rec) => this._meta(rec);
    return null;
  }

  _chainlink(d) {
    if (!d || d.topic !== "crypto_prices_twap_sixty" || !d.payload) return;
    const p = d.payload, sym = String(p.symbol || "").toLowerCase();
    let m = this.twap.get(sym);
    if (!m) this.twap.set(sym, (m = new Map()));
    const points = Array.isArray(p.data) ? p.data : [p];
    for (const x of points) {
      const ts = Number(x && x.timestamp), v = Number(x && x.value);
      if (Number.isFinite(ts) && Number.isFinite(v) && !m.has(ts)) m.set(ts, v);
    }
  }

  _trade(stream, d) {
    if (!d || d.e !== "aggTrade") return;
    const T = Number(d.T), a = Number(d.a), p = Number(d.p);
    if (!Number.isFinite(T) || !Number.isFinite(p)) return;
    const key = `${stream}|${String(d.s).toUpperCase()}`;
    let m = this.minutes.get(key);
    if (!m) this.minutes.set(key, (m = new Map()));
    const minute = Math.floor(T / MIN_MS);
    const c = m.get(minute);
    if (!c) { m.set(minute, { fT: T, fA: a, fP: p, lT: T, lA: a, lP: p }); return; }
    if (T < c.fT || (T === c.fT && a < c.fA)) Object.assign(c, { fT: T, fA: a, fP: p });
    if (T > c.lT || (T === c.lT && a > c.lA)) Object.assign(c, { lT: T, lA: a, lP: p });
  }

  _meta(rec) {
    const d = rec.d;
    if (!d || d.kind !== "window" || !d.slug) return;
    if ((this.windowAt.get(d.slug) || -Infinity) > rec.rt) return;
    this.windowAt.set(d.slug, rec.rt);
    this.windows.set(d.slug, d);
  }

  twapAt(sym, ts) { const m = this.twap.get(sym); return m && m.has(ts) ? m.get(ts) : null; }

  // First trade in [from, to) and last trade in [from, to), by trade time (then aggregate id).
  firstTrade(key, from, to) {
    const m = this.minutes.get(key);
    if (!m) return null;
    for (let minute = Math.floor(from / MIN_MS); minute * MIN_MS < to; minute += 1) {
      const c = m.get(minute);
      if (c && c.fT >= from && c.fT < to) return { t: c.fT, p: c.fP };
    }
    return null;
  }

  lastTrade(key, from, to) {
    const m = this.minutes.get(key);
    if (!m) return null;
    for (let minute = Math.floor((to - 1) / MIN_MS); minute * MIN_MS + MIN_MS > from; minute -= 1) {
      const c = m.get(minute);
      if (c && c.lT >= from && c.lT < to) return { t: c.lT, p: c.lP };
    }
    return null;
  }
}

// Files of one day whose stream and hour match, read into the index (no integrity checks: those are for the main day).
async function loadHours(root, day, want, index) {
  const ddir = path.join(root, day);
  let names;
  try { names = fs.readdirSync(ddir); } catch { return; }
  for (const name of names.sort()) {
    const info = parseName(name);
    if (!info || !want(info)) continue;
    const visit = index.visitor(info.stream);
    if (visit) await scanFile(path.join(ddir, name), visit);
  }
}

function gapsNear(gaps, feed, from, to) {
  return gaps.filter((g) => g.feed === feed && g.from < to && g.to > from);
}

// One window's result from the data: {ours, k, f, sure, note}.
function rebuild(w, index, gaps) {
  if (w.rule === "chainlink-twap60") {
    const sym = `${w.asset}/usd`, k = index.twapAt(sym, w.start), f = index.twapAt(sym, w.end);
    if (k == null || f == null) return { ours: null, k, f, sure: false, note: `no TWAP-60 point at the ${k == null ? "start" : "end"} second` };
    return { ours: f >= k ? "Up" : "Down", k, f, sure: true, note: null };
  }
  if (w.rule === "binance-1h" || w.rule === "binance-1m-close") {
    // Trades are indexed as the first and last of each minute: exact for boundaries on whole minutes, as all are.
    if (w.start % MIN_MS || w.end % MIN_MS) return { ours: null, k: null, f: null, sure: false, note: "boundary not on a whole minute" };
    const sym = `${w.asset.toUpperCase()}USDT`;
    for (const stream of ["binance", "binanceus"]) {
      const key = `${stream}|${sym}`;
      // A price at a boundary counts only if trades were recorded on both sides of it (within PROOF_MS): a recording
      // that began after the start would otherwise pass its first trade off as the open.
      const open = (t) => (index.lastTrade(key, t - PROOF_MS, t) ? index.firstTrade(key, t, t + PROOF_MS) : null);
      const closeAt = (t) => (index.firstTrade(key, t, t + PROOF_MS) ? index.lastTrade(key, t - PROOF_MS, t) : null);
      let k, f, probes;
      if (w.rule === "binance-1h") {
        k = open(w.start);
        f = closeAt(w.end);
        probes = [[w.start - PROOF_MS, w.start + PROOF_MS], [w.end - PROOF_MS, w.end + PROOF_MS]];
      } else {   // the close of the 1-minute candle that opens at the boundary
        k = closeAt(w.start + MIN_MS);
        f = closeAt(w.end + MIN_MS);
        probes = [[w.start, w.start + MIN_MS + PROOF_MS], [w.end, w.end + MIN_MS + PROOF_MS]];
      }
      if (!k || !f) continue;
      const near = probes.flatMap(([a, b]) => gapsNear(gaps, "binance", a, b));
      const ours = w.rule === "binance-1h" ? (f.p >= k.p ? "Up" : "Down") : f.p > k.p ? "Up" : f.p < k.p ? "Down" : "50-50";
      const notes = [];
      if (stream === "binanceus") notes.push("Binance.US prices, not Binance");
      if (near.length) notes.push(`gap near ${near.map((g) => new Date(g.from).toISOString().slice(11, 19)).join(", ")}`);
      return { ours, k: k.p, f: f.p, sure: !notes.length, note: notes.join("; ") || null };
    }
    return { ours: null, k: null, f: null, sure: false, note: "no Binance trades on both sides of the start or the end" };
  }
  return { ours: null, k: null, f: null, sure: false, note: `rule ${w.rule}` };
}

async function checkDay({ dir, day, gapMs = 5000, now = Date.now() }) {
  const root = path.resolve(dir);
  if (!DAY_RE.test(String(day))) { const e = new Error("collector_day_invalid"); e.code = "collector_day_invalid"; throw e; }
  const ddir = path.join(root, day);
  const report = { day, dir: root, gapMs, ok: true, problems: [], files: { checked: 0, lines: 0, bytes: 0, raw: 0, open: [] }, streams: {}, gaps: {}, endpoints: {},
    outcomes: { rules: {}, rows: [] } };
  const problem = (file, code, detail = null) => { report.problems.push({ file, code, detail }); report.ok = false; };
  if (!fs.existsSync(ddir)) { problem(null, "day_missing"); return report; }
  const manifest = readManifest(ddir);
  if (!manifest) problem(MANIFEST, "manifest_missing");
  else if (manifest.broken) problem(MANIFEST, "manifest_unreadable", manifest.broken);
  const files = (manifest && manifest.files) || {};
  report.endpoints = (manifest && manifest.endpoints) || {};
  const index = new Index();

  // 1. files
  for (const name of Object.keys(files).sort()) {
    const e = files[name], full = path.join(ddir, name);
    if (!fs.existsSync(full)) { problem(name, "file_missing"); continue; }
    const scan = await scanFile(full, index.visitor(e.stream));
    report.files.checked += 1;
    if (scan.error) problem(name, "decode_failed", scan.error);
    else {
      if (scan.sha256 !== e.sha256) problem(name, "sha256_mismatch");
      if (scan.lines !== e.lines) problem(name, "lines_mismatch", `${scan.lines} ≠ ${e.lines}`);
      if (scan.first !== e.first || scan.last !== e.last) problem(name, "times_mismatch");
    }
    if (scan.bad) problem(name, "bad_lines", scan.bad);
    const s = report.streams[e.stream] || (report.streams[e.stream] = { files: 0, lines: 0, bytes: 0, raw: 0, first: null, last: null });
    s.files += 1;
    s.lines += scan.lines;
    s.bytes += e.bytes || 0;
    s.raw += e.raw || 0;
    if (scan.first != null && (s.first == null || scan.first < s.first)) s.first = scan.first;
    if (scan.last != null && (s.last == null || scan.last > s.last)) s.last = scan.last;
    report.files.lines += scan.lines;
    report.files.bytes += e.bytes || 0;
    report.files.raw += e.raw || 0;
  }
  for (const name of fs.readdirSync(ddir).sort()) {
    const info = parseName(name);
    if (!info) continue;
    if (!info.open) { if (!files[name]) problem(name, "not_in_manifest"); continue; }
    report.files.open.push(name);
    const visit = index.visitor(info.stream);
    if (visit) await scanFile(path.join(ddir, name), visit);
  }

  // 2. gaps (clipped to the day)
  const dayStart = Date.parse(`${day}T00:00:00Z`), dayEnd = dayStart + DAY_MS;
  const gaps = [...((manifest && manifest.gaps) || [])];
  const before = readManifest(path.join(root, dayOf(day, -1)));
  if (before && Array.isArray(before.gaps)) for (const g of before.gaps) if (!gaps.some((x) => x.from === g.from && x.feed === g.feed)) gaps.push(g);
  const syms = [...index.twap.keys()];
  const filled = (g) => {
    if (g.feed !== "chainlink" || !syms.length) return false;
    const last = Math.min(g.to, dayEnd) - 2000;   // a point arrives about a second after its own second
    for (let t = Math.ceil(Math.max(g.from, dayStart) / 1000) * 1000; t <= last; t += 1000) if (syms.some((sym) => index.twapAt(sym, t) == null)) return false;
    return true;
  };
  for (const g of gaps) {
    if (g.to <= dayStart || g.from >= dayEnd) continue;
    const ms = Math.min(g.to, dayEnd) - Math.max(g.from, dayStart);
    const s = report.gaps[g.feed] || (report.gaps[g.feed] = { n: 0, over: 0, filled: 0, totalMs: 0, maxMs: 0, kinds: {}, longest: [] });
    s.n += 1;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.kinds[g.kind] = (s.kinds[g.kind] || 0) + 1;
    if (g.ms > gapMs) {
      const whole = filled(g);
      if (whole) s.filled += 1;
      else s.over += 1;
      s.longest.push(whole ? { ...g, filled: true } : g);
    }
  }
  for (const s of Object.values(report.gaps)) s.longest = s.longest.sort((a, b) => b.ms - a.ms).slice(0, 20);

  // 3. results: windows that ended this day; data at their start may sit in the day before, the result in the day after
  const prevDay = dayOf(day, -1), nextDay = dayOf(day, 1);
  await loadHours(root, prevDay, (i) => i.stream === "meta", index);
  await loadHours(root, nextDay, (i) => i.stream === "meta", index);
  const ended = [...index.windows.values()].filter((w) => w.end >= dayStart && w.end < dayEnd && w.end <= now)
    .sort((a, b) => a.end - b.end || a.slug.localeCompare(b.slug));
  const hours = new Set();
  for (const w of ended) {
    if (w.start < dayStart) {
      const stream = w.rule === "chainlink-twap60" ? "chainlink" : "binance";
      for (const t of [w.start - PROOF_MS, w.start, w.start + MIN_MS + PROOF_MS]) if (utcDay(t) === prevDay) hours.add(`${stream}|${utcHour(t)}`);
    }
  }
  if (hours.size) await loadHours(root, prevDay, (i) => hours.has(`${i.stream === "binanceus" ? "binance" : i.stream}|${i.hour}`), index);
  for (const w of ended) {
    const r = rebuild(w, index, gaps);
    const official = w.outcome || null;
    const status = w.rule === "unknown" ? "unknown" : official == null ? "pending" : r.ours == null ? "no_data" : r.ours === official ? "match" : "mismatch";
    const row = { slug: w.slug, asset: w.asset, tf: w.tf, rule: w.rule, start: w.start, end: w.end, official, ours: r.ours, status, sure: r.sure,
      k: r.k, f: r.f, ptb: w.ptb ?? null, fin: w.fin ?? null, kAgrees: w.ptb == null || r.k == null ? null : close(r.k, w.ptb),
      fAgrees: w.fin == null || r.f == null ? null : close(r.f, w.fin), note: r.note };
    report.outcomes.rows.push(row);
    const s = report.outcomes.rules[w.rule] || (report.outcomes.rules[w.rule] = { n: 0, match: 0, mismatch: 0, no_data: 0, pending: 0, unknown: 0, unsure: 0,
      kAgree: 0, kDiffer: 0, fAgree: 0, fDiffer: 0 });
    s.n += 1;
    s[status] += 1;
    if (!r.sure && r.ours != null) s.unsure += 1;
    if (row.kAgrees === true) s.kAgree += 1;
    if (row.kAgrees === false) s.kDiffer += 1;
    if (row.fAgrees === true) s.fAgree += 1;
    if (row.fAgrees === false) s.fDiffer += 1;
    if (status === "mismatch") report.ok = false;
  }
  return report;
}

module.exports = { checkDay, rebuild, Index };
