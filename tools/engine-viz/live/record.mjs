// Record a live session of all markets for a deterministic replay (index.html?replay=<out.js>&from=<s>):
//   node record.mjs <seconds> <out.js> [replaySeconds=240]       record live, then cut
//   node record.mjs --cut <raw.jsonl> <out.js> [replaySeconds]   cut a raw recording again
// Recording: every event goes as one JSON line to <out>.raw.jsonl (books make it ~0.6 MB a second). The recorder asks
// for what the page would over a session: details of the 1000 busiest events and of every event that trades, the
// events of token-only fills, and the books of the leading market of the 40 busiest events outside crypto Up/Down (as if
// each were in focus once).
// Cut: everything but books is kept from the start, so the first replay frame already carries minutes of trace; books
// only for the last replaySeconds, from the real state at the cut (rebuilt by the Engine) as snapshots. Level changes
// are merged per token in 100 ms, only outcome-0 tokens are kept (outcome 1 mirrors them), ids are shortened.
import { createRequire } from "node:module";
import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const require = createRequire(import.meta.url);
const { Feeds, row, mrow } = require("./feeds.js");
const { Engine } = require("./core.js");
const GAMMA = "https://gamma-api.polymarket.com", CO = 100;
const args = process.argv.slice(2);
if (args[0] === "--cut") await cut(args[1], args[2] || "rec.js", +(args[3] || 240));
else { const [secs = "600", out = "rec.js", rep = "240"] = args; await cut(await record(+secs, `${out}.raw.jsonl`), out, +rep); }
process.exit(0);

function record(secs, raw) {
  return new Promise((done) => {
    const f = createWriteStream(raw), t0 = Date.now(), seen = new Set(), slugs = [], toks = [], top = [], evd = new Map();
    let n = 0, fills = 0, booked = false;
    const feeds = new Feeds((e) => {
      f.write(JSON.stringify(e) + "\n"); n++;
      if (e.k === "trade") { fills++; if (e.ev) { if (!seen.has(e.ev)) { seen.add(e.ev); slugs.push(e.ev); } } else if (e.tok) toks.push(e.tok); }
      else if (e.k === "cat" && e.n < 10) { feeds.details(e.rows.map((r) => ({ id: r.id }))); top.push(...e.rows); }
      else if (e.k === "evd") evd.set(e.id, e);
    }).start();
    const pump = setInterval(() => {
      if (slugs.length) feeds.details(slugs.splice(0).map((slug) => ({ slug })));
      if (toks.length) feeds.resolve(toks.splice(0));
      if (!booked && evd.size >= 300) {
        const want = [];
        for (const r of top) {
          if (want.length >= 40) break;
          const e = !/-updown-|-up-or-down-/.test(r.s) && evd.get(r.id), m = e && e.mk.filter((x) => !x.x && x.tk[0]).sort((a, b) => b.v - a.v)[0];
          if (m) want.push(m.tk[0]);
        }
        feeds.books(want); booked = true;
      }
    }, 1000);
    const tick = setInterval(() => process.stderr.write(`\r${((Date.now() - t0) / 1000).toFixed(0)} s · ${n} events · ${fills} fills · ${evd.size} events with details   `), 5000);
    setTimeout(() => { clearInterval(pump); clearInterval(tick); feeds.stop(); f.end(() => { process.stderr.write(`\n${n} events → ${raw}\n`); done(raw); }); }, secs * 1000);
  });
}

async function cut(src, out, repS) {
  const lines = () => createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  let tFirst = Infinity, tLast = 0;
  const up = new Set(), gen = new Set(), engTok = new Set(), orph = new Set(), known = new Set();
  for await (const l of lines()) {
    const m = /"rt":(\d+)/.exec(l); if (m) { const r = +m[1]; if (r < tFirst) tFirst = r; if (r > tLast) tLast = r; }
    if (l.startsWith('{"k":"mkt"')) { const e = JSON.parse(l); if (e.toks) { if (e.toks[0]) up.add(e.toks[0]); e.toks.forEach((t) => t && engTok.add(t)); } }
    else if (l.startsWith('{"k":"book"')) { const t = /"tok":"(\d+)"/.exec(l); if (t) gen.add(t[1]); }
    else if (l.startsWith('{"k":"trade","slug":"","ev":""')) { const t = /"tok":"(\d+)"/.exec(l); if (t) orph.add(t[1]); }
    else if (l.startsWith('{"k":"evd"')) for (const x of JSON.parse(l).mk) for (const t of x.tk) if (t) known.add(t);
  }
  // token-only fills whose event never came during the recording: fetched now, put at the start
  const extra = [], miss = [...orph].filter((t) => !known.has(t)), slugs = new Set();
  const get = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : []; } catch (e) { return []; } };
  for (let i = 0; i < miss.length; i += 20) for (const m of await get(`${GAMMA}/markets?${miss.slice(i, i + 20).map((t) => `clob_token_ids=${t}`).join("&")}`)) for (const e of m.events || []) if (e.slug) slugs.add(e.slug);
  const L = [...slugs];
  for (let i = 0; i < L.length; i += 30) for (const e of await get(`${GAMMA}/events?${L.slice(i, i + 30).map((s) => `slug=${encodeURIComponent(s)}`).join("&")}&market_projection=card`)) extra.push(Object.assign({ k: "evd", mk: (e.markets || []).map(mrow) }, row(e), { rt: tFirst }));
  for (const t of engTok) gen.delete(t);
  const keepTok = (t) => up.has(t) || gen.has(t), cutAt = tLast - repS * 1000;
  process.stderr.write(`span ${((tLast - tFirst) / 1000).toFixed(0)} s · books from −${repS} s · ${up.size} engine tokens, ${gen.size} other books · ${miss.length} unresolved fill tokens → ${extra.length} events\n`);
  const eng = new Engine(), keep = [], isBook = (k) => k === "book" || k === "pc" || k === "ltp", pseudo = /^0x[0-9a-fA-F]{40}-\d+$/;
  let n = 0, pend = null, snapped = false;
  const flush = () => { if (pend) { pend.ch = [...pend.map.values()]; delete pend.map; delete pend.b; keep.push(pend); pend = null; } };
  const snap = () => {   // the real book state at the cut
    eng.advance(cutAt);
    for (const m of eng.mk.values()) if (m.toks && m.bookRt) { const B = eng.levels(m); keep.push({ k: "book", tok: m.toks[0], ts: null, bids: B.bids, asks: B.asks, rt: cutAt, cut: 1 }); }
    for (const [tok, b] of eng.uni.books) if (b.bookRt && gen.has(tok)) { const B = eng.uni.levels(b); keep.push({ k: "book", tok, ts: null, bids: B.bids, asks: B.asks, rt: cutAt, cut: 1 }); }
    snapped = true;
  };
  for (const e of extra) { eng.push(e); keep.push(e); }
  for await (const l of lines()) {
    const e = JSON.parse(l);
    if (e.rt <= cutAt) { eng.push(e); if (++n % 2000 === 0) eng.advance(e.rt); if (isBook(e.k)) continue; }
    else if (!snapped) snap();
    if (e.k === "trade" && e.name && pseudo.test(e.name)) e.name = "";
    if (e.rt > cutAt && isBook(e.k)) {
      if (e.k === "pc") {
        const ch = e.ch.filter((c) => keepTok(c[0]));
        if (!ch.length) continue;
        const b = Math.floor(e.rt / CO);
        if (pend && pend.b !== b) flush();
        if (!pend) pend = { k: "pc", ts: e.ts, rt: e.rt, b, map: new Map() };
        for (const c of ch) { const k = `${c[0]}|${c[3]}|${c[1]}`; pend.map.delete(k); pend.map.set(k, c); }
        pend.ts = e.ts; pend.rt = e.rt;
        continue;
      }
      if (!keepTok(e.tok)) continue;
    }
    if (e.rt > cutAt) flush();
    keep.push(e);
  }
  flush();
  if (!snapped) snap();
  // shorter ids: tokens t…, condition ids c…
  const T = new Map(), C = new Map(), tid = (t) => { if (!t) return t; let v = T.get(t); if (!v) T.set(t, (v = `t${T.size.toString(36)}`)); return v; };
  const cid = (c) => { if (!c) return c; let v = C.get(c); if (!v) C.set(c, (v = `c${C.size.toString(36)}`)); return v; };
  for (const e of keep) {
    if (e.toks) e.toks = e.toks.map(tid);
    if (e.tok) e.tok = tid(e.tok);
    if (e.cond) e.cond = cid(e.cond);
    if (e.k === "res" && e.win) e.win = tid(e.win);
    if (e.ch) for (const c of e.ch) c[0] = tid(c[0]);
    if (e.mk) for (const m of e.mk) { m.c = cid(m.c); m.tk = m.tk.map(tid); }
  }
  keep.sort((a, b) => a.rt - b.rt);
  const s = `window.VESPERA_REC = ${JSON.stringify({ t0: cutAt, t1: tLast, start: tFirst, events: keep })};\n`;
  writeFileSync(out, s);
  process.stderr.write(`saved ${keep.length} events, ${(s.length / 1e6).toFixed(1)} MB → ${out}\n`);
}
