// paper_lp4: same model as paper_lp3 but re-quotes every POLL_MS (default 10 s) on a smaller high-return universe.
// Forward paper LP simulation on Polymarket liquidity-reward markets (no orders are ever sent).
// Every minute: unified YES book for each market (POST /books) -> cutoff-adjusted mid, competitor reward score Q per side;
// pick-off check (real book crossed our virtual quote -> filled at our price); re-quote at mid -/+ k*v; reward sample.
// Between polls: every taker trade from the RTDS activity firehose that reaches our price fills our virtual order.
// Usage: node paper_lp.js universe.json outdir
const fs = require('node:fs'), path = require('node:path');
const U = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3]; fs.mkdirSync(OUT, { recursive: true });
const VARIANTS = [{ id: 'g', k: 1 / 3, robust: true, volf: true, skew: true }, { id: 'h', k: 1 / 3, robust: true, center: true, tight: 0.25, volf: true, skew: true }];
const POLL = +(process.env.POLL_MS || 10000), RAWN = Math.round(600000 / POLL), FVN = Math.max(5, Math.round(60000 / POLL)); // 10-min history, ~1-min robust median
const MAXINV = 4; // inventory cap, multiples of quote size
const EPS = 1e-9;
const byCid = new Map();
const STATE = path.join(OUT, 'state.json');
let saved = null; try { saved = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
for (const m of U) {
  m.st = {};
  for (const V of VARIANTS) m.st[V.id] = saved?.m?.[m.cid]?.[V.id] || { bid: null, ask: null, cash: 0, inv: 0, nf: 0, fq: 0, rA: 0, rP: 0, ns: 0, nq: 0, capMax: 0 };
  m.mid = saved?.mid?.[m.cid] ?? null; m.mk = saved?.mk?.[m.cid] ?? null; m.raw = saved?.raw?.[m.cid] || []; byCid.set(m.cid, m);
}
const meta = saved?.meta || { started: Date.now(), polls: 0, rtdsMsgs: 0, rtdsOurs: 0, rtdsDownMs: 0 };
const log = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + '\n');
const S = (m, d) => (d >= 0 && d < m.v - EPS ? ((m.v - d) / m.v) ** 2 : 0);
const rnd = (x, t) => Math.round(x / t) * t;

function fill(m, V, st, which, q, px, how) {
  if (q <= EPS) return;
  const o = st[which]; o.rem -= q;
  if (which === 'bid') { st.cash -= q * px; st.inv += q; } else { st.cash += q * px; st.inv -= q; }
  st.nf += 1; st.fq += q;
  log('fills.jsonl', { t: Date.now(), cid: m.cid, slug: m.slug, v: V.id, side: which, px: +px.toFixed(4), q: +q.toFixed(2), how, mid: m.mid, inv: +st.inv.toFixed(2) });
}

// ---- RTDS trades ----
let ws = null, wsOpen = false, downSince = Date.now(), lastMsg = 0;
function connect() {
  ws = new WebSocket('wss://ws-live-data.polymarket.com');
  ws.onopen = () => {
    wsOpen = true; lastMsg = Date.now();
    if (downSince) { meta.rtdsDownMs += Date.now() - downSince; downSince = 0; }
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] }));
  };
  ws.onmessage = (e) => {
    lastMsg = Date.now();
    if (typeof e.data !== 'string' || e.data[0] !== '{') return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.topic !== 'activity') return;
    meta.rtdsMsgs++;
    const p = d.payload; const m = p && byCid.get(p.conditionId); if (!m) return;
    meta.rtdsOurs++;
    let px = +p.price, side = p.side; const sz = +p.size;
    if (p.asset === m.tok2) { px = 1 - px; side = side === 'BUY' ? 'SELL' : 'BUY'; } else if (p.asset !== m.tok) return;
    log('trades.jsonl', { t: Date.now(), ts: p.timestamp, cid: m.cid, px: +px.toFixed(4), side, sz, tx: p.transactionHash });
    for (const V of VARIANTS) {
      const st = m.st[V.id];
      if (side === 'SELL' && st.bid && st.bid.rem > EPS && px <= st.bid.px + EPS) fill(m, V, st, 'bid', Math.min(st.bid.rem, sz), st.bid.px, 'trade');
      if (side === 'BUY' && st.ask && st.ask.rem > EPS && px >= st.ask.px - EPS) fill(m, V, st, 'ask', Math.min(st.ask.rem, sz), st.ask.px, 'trade');
    }
  };
  ws.onclose = () => { wsOpen = false; if (!downSince) downSince = Date.now(); setTimeout(connect, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
connect();
setInterval(() => {
  if (wsOpen) { try { ws.send('PING'); } catch {} }
  if (wsOpen && Date.now() - lastMsg > 20000) { try { ws.close(); } catch {} } // stalled
}, 5000);

// ---- books ----
async function books(toks) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://clob.polymarket.com/books', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toks.map((t) => ({ token_id: t }))), signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}
function cutBest(levels, ms, desc) {
  const a = levels.map((x) => [+x.price, +x.size]).sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]));
  let c = 0; for (const [p, s] of a) { c += s; if (c >= ms) return p; } return null;
}
async function poll() {
  const t = Date.now(); meta.polls++;
  const batches = []; for (let i = 0; i < U.length; i += 100) batches.push(U.slice(i, i + 100));
  const got = new Map(); let ok = 0;
  for (let i = 0; i < batches.length; i += 5) {
    const res = await Promise.all(batches.slice(i, i + 5).map((b) => books(b.map((m) => m.tok))));
    for (const r of res) if (r) for (const b of r) got.set(b.asset_id, b);
  }
  const mids = [];
  const tot = Object.fromEntries(VARIANTS.map((V) => [V.id, { rA: 0, rP: 0, mtm: 0, cash: 0, invv: 0, nf: 0, nq: 0, ns: 0, cap: 0 }]));
  for (const m of U) {
    const b = got.get(m.tok);
    if (!b) { mids.push(null); continue; }
    ok++;
    if (b.tick_size) m.tick = +b.tick_size;
    const bids = b.bids || [], asks = b.asks || [];
    const rbb = bids.length ? Math.max(...bids.map((x) => +x.price)) : null, rba = asks.length ? Math.min(...asks.map((x) => +x.price)) : null;
    const bb = cutBest(bids, m.ms, true), ba = cutBest(asks, m.ms, false);
    const mid = bb != null && ba != null ? (bb + ba) / 2 : null;
    m.mid = mid; mids.push(mid == null ? null : +mid.toFixed(4));
    const rawMid = rbb != null && rba != null && rba - rbb <= 2 * m.v + EPS ? (rbb + rba) / 2 : null;
    m.raw.push(rawMid); if (m.raw.length > RAWN) m.raw.shift();
    const rv = m.raw.slice(-FVN).filter((x) => x != null).sort((x, y) => x - y);
    const fv = rv.length >= Math.ceil(FVN / 2) + 1 && m.raw[m.raw.length - 1] != null ? rv[Math.floor(rv.length / 2)] : null;
    m.fv = fv;
    const r10 = m.raw.filter((x) => x != null); const span10 = r10.length ? Math.max(...r10) - Math.min(...r10) : 1;
    let qb = 0, qa = 0;
    if (mid != null) {
      for (const x of bids) { const p = +x.price, s = +x.size; if (s >= m.ms) qb += S(m, mid - p) * s; }
      for (const x of asks) { const p = +x.price, s = +x.size; if (s >= m.ms) qa += S(m, p - mid) * s; }
    }
    for (const V of VARIANTS) {
      const st = m.st[V.id];
      // pick-off: someone in the real book is now willing to trade through our resting quote
      if (st.bid && st.bid.rem > EPS && rba != null && rba <= st.bid.px + EPS) fill(m, V, st, 'bid', st.bid.rem, st.bid.px, 'cross');
      if (st.ask && st.ask.rem > EPS && rbb != null && rbb >= st.ask.px - EPS) fill(m, V, st, 'ask', st.ask.rem, st.ask.px, 'cross');
      st.bid = st.ask = null;
      if (mid == null) continue;
      let ref = mid;
      if (V.robust) {
        if (fv == null || Math.abs(mid - fv) > (V.tight ?? 0.5) * m.v) continue;      // no trustworthy fair value / scoring mid far from it
        if (V.volf && span10 > m.v) continue;                          // fair value moved > v within the last 10 min
        ref = V.center ? mid : fv;                                     // center on the scoring mid once it agrees with the fair value
        if (V.skew) ref -= (st.inv / (MAXINV * m.size)) * (m.v / 3);  // lean against inventory
      }
      const d = V.k * m.v, tk = m.tick;
      let bp = Math.floor((ref - d) / tk + EPS) * tk, ap = Math.ceil((ref + d) / tk - EPS) * tk;
      if (mid - bp >= m.v - EPS) bp += tk; if (ap - mid >= m.v - EPS) ap -= tk;
      if (rba != null && bp >= rba - EPS) bp = rba - tk; if (rbb != null && ap <= rbb + EPS) ap = rbb + tk;
      bp = +rnd(bp, tk).toFixed(4); ap = +rnd(ap, tk).toFixed(4);
      if (bp >= tk - EPS && bp < mid && st.inv < MAXINV * m.size - EPS) st.bid = { px: bp, sz: m.size, rem: m.size };
      if (ap <= 1 - tk + EPS && ap > mid && st.inv > -MAXINV * m.size + EPS) st.ask = { px: ap, sz: m.size, rem: m.size };
      const q1 = st.bid ? S(m, mid - st.bid.px) * m.size : 0, q2 = st.ask ? S(m, st.ask.px - mid) * m.size : 0;
      const two = mid >= 0.1 && mid <= 0.9;
      const qm = two ? Math.max(Math.min(q1, q2), Math.max(q1, q2) / 3) : Math.min(q1, q2);
      const cA = two ? Math.max(Math.min(qb, qa), Math.max(qb, qa) / 3) : Math.min(qb, qa), cP = qb + qa;
      const per = m.rate / (86400000 / POLL);
      if (st.bid || st.ask) st.nq++;
      if (qm > EPS) { st.ns++; st.rA += per * qm / (qm + cA); st.rP += per * qm / (qm + cP); }
    }
  }
  for (const m of U) {
    if (m.fv != null) m.mk = m.fv; else if (m.mid != null && m.mk == null) m.mk = m.mid;
    const mk = m.mk; if (mk == null) continue;
    for (const V of VARIANTS) {
      const st = m.st[V.id];
      const cap = (st.bid ? st.bid.px * m.size : 0) + (st.ask ? (1 - st.ask.px) * m.size : 0) + Math.abs(st.inv) * (st.inv > 0 ? mk : 1 - mk);
      st.capMax = Math.max(st.capMax, cap);
      const T = tot[V.id]; T.rA += st.rA; T.rP += st.rP; T.cash += st.cash; T.invv += st.inv * mk; T.mtm += st.cash + st.inv * mk; T.nf += st.nf;
      T.nq += st.bid || st.ask ? 1 : 0; T.cap += cap;
    }
  }
  for (const V of VARIANTS) for (const k in tot[V.id]) tot[V.id][k] = +tot[V.id][k].toFixed(2);
  log('minutes.jsonl', { t, ok, ms: Date.now() - t, rtds: { open: wsOpen, msgs: meta.rtdsMsgs, ours: meta.rtdsOurs, downMs: meta.rtdsDownMs + (downSince ? Date.now() - downSince : 0) }, tot });
  fs.appendFileSync(path.join(OUT, 'mids.jsonl'), JSON.stringify({ t, mids }) + '\n');
  const snap = { meta, m: {}, mid: {} };
  snap.raw = {}; snap.mk = {};
  for (const m of U) { snap.m[m.cid] = m.st; snap.mid[m.cid] = m.mid; snap.raw[m.cid] = m.raw; snap.mk[m.cid] = m.mk; }
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(snap)); fs.renameSync(STATE + '.tmp', STATE);
}
let busy = false;
async function loop() {
  if (!busy) { busy = true; try { await poll(); } catch (e) { log('errors.jsonl', { t: Date.now(), e: String(e && e.stack || e) }); } busy = false; }
  const now = Date.now(); setTimeout(loop, POLL - (now % POLL) + 500);
}
setTimeout(loop, 3000);
process.on('SIGTERM', () => process.exit(0));
