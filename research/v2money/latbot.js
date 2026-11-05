// latbot.js — live PAPER bot for the pre-registered rule latarb_v1 (no orders are ever sent).
// Binance aggTrade -> 1 s log-return of the last trade vs the last trade at or before T-1s > J bps, 3 s cooldown per asset
// -> for every live Up/Down window of that asset (>= 5 s after start, >= 5 s before end): virtual taker buy of the jump side
// at the CLOB best ask as it stood at Binance exchange time T + L (Polymarket server timestamps), size <= CAP,
// taker fee 0.07*p*(1-p). Valued at mid +10 s, mid +60 s (capped at window end), realizable exit at the +10 s bid
// (2 fees), the +60 s bid (2 fees) and at resolution. Also a "live" entry: L = our actual Binance receive delay + TRANSIT ms.
// Usage: node latbot.js outdir [--assets btc,eth] [--tfs 5m,15m]
'use strict';
const fs = require('node:fs'), path = require('node:path');
const OUT = process.argv[2] || 'out'; fs.mkdirSync(OUT, { recursive: true });
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ASSETS = arg('--assets', 'btc,eth').split(','), TFS = arg('--tfs', '5m,15m').split(',');
const J = 2.0, COOL = 3000, L = 150, TRANSIT = 50, CAP = 100, FEE = 0.07, EDGE_MS = 5000;
const LEN = { '5m': 300, '15m': 900 }, SYM = { btc: 'BTCUSDT', eth: 'ETHUSDT' };
const log = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + '\n');
const say = (s) => log('run.jsonl', { t: Date.now(), s });
const fee = (p) => FEE * p * (1 - p);

// ---------- windows ----------
const wins = new Map();          // slug -> { asset, tf, start, end, up, slug, hist: [[ts,bb,bbs,ba,bas]], book, outcome }
const byTok = new Map();
async function json(url) { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function ensureWindows() {
  const now = Date.now() / 1000;
  for (const a of ASSETS) for (const tf of TFS) {
    const len = LEN[tf], s0 = Math.floor(now / len) * len;
    for (const s of [s0, s0 + len]) {
      const slug = `${a}-updown-${tf}-${s}`; if (wins.has(slug)) continue;
      try {
        const d = await json(`https://gamma-api.polymarket.com/markets?slug=${slug}`); const m = d && d[0]; if (!m) continue;
        const toks = JSON.parse(m.clobTokenIds), outs = JSON.parse(m.outcomes); const up = toks[outs.indexOf('Up')];
        const w = { asset: a, tf, start: s * 1000, end: (s + len) * 1000, up, slug, hist: [], book: null, outcome: null };
        wins.set(slug, w); byTok.set(up, w); subscribe([up]);
      } catch (e) { say(`gamma ${slug}: ${e.message}`); }
    }
  }
  const t = Date.now();
  for (const [slug, w] of wins) if (t > w.end + 15 * 60000 && w.outcome != null) { wins.delete(slug); byTok.delete(w.up); unsubscribe([w.up]); }
}
async function resolve() {
  for (const w of wins.values()) {
    if (w.outcome != null || Date.now() < w.end + 60000) continue;
    try {
      const d = await json(`https://gamma-api.polymarket.com/markets?slug=${w.slug}&closed=true`); const m = d && d[0];
      if (m && m.umaResolutionStatus === 'resolved') { const p = JSON.parse(m.outcomePrices); w.outcome = +p[JSON.parse(m.outcomes).indexOf('Up')] > 0.5 ? 1 : 0; settle(w); }
    } catch (e) {}
  }
}

// ---------- CLOB market socket (Up tokens; the Down book is its mirror) ----------
let clob = null, clobOpen = false, clobLast = 0; const subs = new Set();
function subscribe(toks) { toks.forEach((x) => subs.add(x)); if (clobOpen) clob.send(JSON.stringify({ assets_ids: toks, operation: 'subscribe', custom_feature_enabled: true })); }
function unsubscribe(toks) { toks.forEach((x) => subs.delete(x)); if (clobOpen) clob.send(JSON.stringify({ assets_ids: toks, operation: 'unsubscribe' })); }
function top(b) {
  let bb = -1, ba = 2; for (const p of b.bids.keys()) if (p > bb) bb = p; for (const p of b.asks.keys()) if (p < ba) ba = p;
  return [bb, bb >= 0 ? b.bids.get(bb) : 0, ba, ba <= 1 ? b.asks.get(ba) : 0];
}
function push(w, ts) {
  const t = top(w.book); if (!(t[0] > 0) || !(t[2] < 1.5)) return;   // as offline: skip states with an empty side
  const h = w.hist, last = h[h.length - 1];
  if (last && last[1] === t[0] && last[2] === t[1] && last[3] === t[2] && last[4] === t[3]) return;
  h.push([ts, ...t]); while (h.length > 50000 || (h.length && h[0][0] < ts - 20 * 60000 && h.length > 2)) h.shift();
}
function connectClob() {
  clob = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  clob.onopen = () => { clobOpen = true; clobLast = Date.now(); clob.send(JSON.stringify({ assets_ids: [...subs], type: 'market', custom_feature_enabled: true })); say('clob open'); };
  clob.onmessage = (e) => {
    clobLast = Date.now(); if (typeof e.data !== 'string' || (e.data[0] !== '{' && e.data[0] !== '[')) return;
    let j; try { j = JSON.parse(e.data); } catch { return; }
    for (const x of Array.isArray(j) ? j : [j]) {
      const et = x.event_type || (x.bids ? 'book' : '');
      if (et === 'book') { const w = byTok.get(x.asset_id); if (!w) continue;
        w.book = { bids: new Map(x.bids.map((q) => [+q.price, +q.size])), asks: new Map(x.asks.map((q) => [+q.price, +q.size])) }; push(w, +x.timestamp); }
      else if (et === 'price_change') for (const c of x.price_changes || []) {
        const w = byTok.get(c.asset_id); if (!w || !w.book) continue; const side = c.side === 'BUY' ? w.book.bids : w.book.asks;
        if (+c.size === 0) side.delete(+c.price); else side.set(+c.price, +c.size); push(w, +x.timestamp);
      }
    }
  };
  clob.onclose = () => { clobOpen = false; say('clob closed'); for (const w of wins.values()) w.book = null; setTimeout(connectClob, 1000); };
  clob.onerror = () => { try { clob.close(); } catch {} };
}
setInterval(() => { if (clobOpen) { try { clob.send('PING'); } catch {} if (Date.now() - clobLast > 15000) try { clob.close(); } catch {} } }, 2000);

// ---------- Binance ----------
const tr = Object.fromEntries(ASSETS.map((a) => [a, { T: [], lp: [], lastEv: -1e18 }]));
let bn = null, bnLast = 0; const BN = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision']; let bnI = 0;
function connectBn() {
  bn = new WebSocket(`${BN[bnI % BN.length]}/stream?streams=${ASSETS.map((a) => SYM[a].toLowerCase() + '@aggTrade').join('/')}`);
  bn.onopen = () => { bnLast = Date.now(); say(`binance open ${BN[bnI % BN.length]}`); };
  bn.onmessage = (e) => {
    const rt = Date.now(); bnLast = rt; let m; try { m = JSON.parse(e.data); } catch { return; }
    const d = m.data; if (!d || d.e !== 'aggTrade') return; const a = ASSETS.find((x) => SYM[x] === d.s); if (!a) return;
    const s = tr[a], T = d.T, lp = Math.log(+d.p);
    s.T.push(T); s.lp.push(lp); while (s.T.length > 2 && s.T[1] <= T - 5000) { s.T.shift(); s.lp.shift(); }
    let i = -1; for (let k = s.T.length - 1; k >= 0; k--) if (s.T[k] <= T - 1000) { i = k; break; }
    if (i < 0) return; const ch = (lp - s.lp[i]) * 1e4;
    if (Math.abs(ch) > J && T - s.lastEv > COOL) { s.lastEv = T; onJump(a, T, rt, Math.sign(ch), ch); }
  };
  bn.onclose = () => { say('binance closed'); bnI++; setTimeout(connectBn, 1000); };
  bn.onerror = () => { try { bn.close(); } catch {} };
}
setInterval(() => { if (bn && Date.now() - bnLast > 15000) try { bn.close(); } catch {} }, 5000);

// ---------- paper trades ----------
const open = [];   // virtual positions awaiting valuation
function at(w, ts) { const h = w.hist; let lo = 0, hi = h.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r >= 0 ? h[r] : null; }
function entry(w, sg, ts) {
  const q = at(w, ts); if (!q || !(q[1] > 0) || !(q[3] < 1.5)) return null;
  const px = sg > 0 ? q[3] : 1 - q[1], sz = Math.min(sg > 0 ? q[4] : q[2], CAP);
  if (px >= 0.99 || px <= 0.01 || !(sz > 0)) return null; return { px, sz, f: fee(px) };
}
const mid = (q) => (q[1] + q[3]) / 2;
function onJump(a, T, rt, sg, ch) {
  log('events.jsonl', { a, T, rt, recv: rt - T, sg, ch: +ch.toFixed(2) });
  for (const w of wins.values()) {
    if (w.asset !== a || T < w.start + EDGE_MS || T > w.end - EDGE_MS) continue;
    const Llive = rt - T + TRANSIT;
    setTimeout(() => {                    // by now the book up to server time T + max(L, Llive) has arrived
      const e = entry(w, sg, T + L), el = entry(w, sg, T + Llive); if (!e) return;
      const p = { slug: w.slug, a, tf: w.tf, T, sg, recv: rt - T, ...e, live: el, w };
      open.push(p);
      setTimeout(() => value(p, 10), Math.max(0, T + 10000 + 1500 - Date.now()));
      setTimeout(() => value(p, 60), Math.max(0, Math.min(T + 60000, w.end) + 1500 - Date.now()));
    }, Math.max(0, T + Math.max(L, Llive) + 1500 - Date.now()));
  }
}
function value(p, k) {
  const ts = k === 10 ? p.T + 10000 : Math.min(p.T + 60000, p.w.end); const q = at(p.w, ts); if (!q) return;
  const v = p.sg > 0 ? mid(q) : 1 - mid(q);
  if (k === 10) { p.v10 = v; p.x10 = p.sg > 0 ? q[1] : 1 - q[3]; p.xs10 = p.sg > 0 ? q[2] : q[4]; } else { p.v60 = v; p.x60 = p.sg > 0 ? q[1] : 1 - q[3]; p.xs60 = p.sg > 0 ? q[2] : q[4]; }
  if (p.w.outcome != null) settle(p.w);
}
function settle(w) {
  for (let i = open.length - 1; i >= 0; i--) {
    const p = open[i]; if (p.w !== w || p.v10 == null || p.v60 == null || w.outcome == null) continue;
    const vy = p.sg > 0 ? w.outcome : 1 - w.outcome;
    const r = { slug: p.slug, a: p.a, tf: p.tf, T: p.T, sg: p.sg, recv: p.recv, px: p.px, sz: p.sz, fee: +p.f.toFixed(5), v10: p.v10, v60: p.v60, vy,
      x10: p.x10, xs10: p.xs10, e10: +(p.v10 - p.px - p.f).toFixed(4), ex10: +(p.x10 - p.px - p.f - fee(p.x10)).toFixed(4), ey: +(vy - p.px - p.f).toFixed(4),
      x60: p.x60, xs60: p.xs60, ex60: +(p.x60 - p.px - p.f - fee(p.x60)).toFixed(4),
      live: p.live ? { px: p.live.px, sz: p.live.sz, e10: +(p.v10 - p.live.px - p.live.f).toFixed(4) } : null };
    log('trades.jsonl', r); open.splice(i, 1);
  }
}
setInterval(() => { for (const w of wins.values()) if (w.outcome != null) settle(w); }, 10000);

// ---------- run ----------
(async () => {
  say(`start assets ${ASSETS} tfs ${TFS} J ${J} L ${L} cap ${CAP}`);
  await ensureWindows(); connectClob(); connectBn();
  setInterval(() => ensureWindows().catch(() => {}), 10000);
  setInterval(() => resolve().catch(() => {}), 15000);
  setInterval(() => log('status.jsonl', { t: Date.now(), clobOpen, subs: subs.size, wins: wins.size, open: open.length,
    hist: [...wins.values()].map((w) => w.hist.length).reduce((x, y) => x + y, 0) }), 60000);
})();
process.on('SIGTERM', () => process.exit(0));
