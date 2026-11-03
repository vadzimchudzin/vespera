// Record a live session for deterministic replay:  node record.mjs <seconds> <out.js> [bookSeconds]
// Replay: open index.html?replay=<out.js>&from=<s>. Token ids are shortened. To keep the file small, book messages
// are kept only for the last [bookSeconds] (default 240); at that cut the real book state, rebuilt from the full
// stream, is written as one snapshot per market.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Feeds } = require("./feeds.js");
const { Engine } = require("./core.js");
const [secs = "600", out = "rec.js", bookS = "240"] = process.argv.slice(2);
const events = [], t0 = Date.now();
const feeds = new Feeds((e) => events.push(e)).start();
const timer = setInterval(() => process.stderr.write(`\r${((Date.now() - t0) / 1000).toFixed(0)} s · ${events.length} events   `), 5000);
setTimeout(() => {
  clearInterval(timer); feeds.stop();
  const t1 = Date.now(), cut = t1 - +bookS * 1000, isBook = (e) => e.k === "book" || e.k === "pc";
  const eng = new Engine();
  let i = 0;
  for (; i < events.length && events[i].rt <= cut; i++) eng.push(events[i]);
  eng.advance(cut);
  const keep = events.filter((e, j) => j >= i || !isBook(e));
  const snaps = [];
  for (const m of eng.mk.values()) if (m.toks && m.bookRt) {
    const L = eng.levels(m);
    snaps.push({ k: "book", tok: m.toks[0], ts: null, bids: L.bids, asks: L.asks, rt: cut, cut: 1 });
  }
  const at = keep.findIndex((e) => e.rt > cut);
  keep.splice(at < 0 ? keep.length : at, 0, ...snaps);
  const ids = new Map(), sid = (t) => { if (!t) return t; if (!ids.has(t)) ids.set(t, `t${ids.size}`); return ids.get(t); };
  for (const e of keep) {
    if (e.toks) e.toks = e.toks.map(sid);
    if (e.tok) e.tok = sid(e.tok);
    if (e.k === "res") e.win = sid(e.win);
    if (e.ch) e.ch.forEach((c) => { c[0] = sid(c[0]); });
  }
  writeFileSync(out, `window.VESPERA_REC = ${JSON.stringify({ t0, t1, bookCut: cut, events: keep })};\n`);
  process.stderr.write(`\nsaved ${keep.length} of ${events.length} events (${snaps.length} book snapshots at the cut) to ${out}\n`);
  process.exit(0);
}, +secs * 1000);
