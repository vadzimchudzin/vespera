// lp_universe.js — builds the LP paper universe (same rules as the research pipeline, frozen 2026-11-05):
// active reward markets with rate >= $5/day, non-sports, >= 3 days to end, cutoff mid 0.10-0.90, raw spread <= 2v;
// ranked by expected reward per $ of capital at the snapshot (our quote at mid -/+ max(tick, v/3), agg competitor rule).
// Usage: node lp_universe.js out/universe.json [topN=300]
'use strict';
const fs = require('node:fs');
const OUT = process.argv[2] || 'universe.json', TOP = +(process.argv[3] || 300);
const SPORT = /^(lol|cs2|csgo|dota|val|nfl|nba|nhl|mlb|epl|ucl|uel|atp|wta|ufc|cbb|cfb|mls)-/;
const today = new Date().toISOString().slice(0, 10);
async function get(u, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(u, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) } : { signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}
const rate = (r) => (r.rewards_config || []).reduce((s, c) => s + ((c.end_date || '9999') >= today && (c.start_date || '0000') <= today ? +c.rate_per_day || 0 : 0), 0);
function cutBest(levels, ms, desc) {
  const a = levels.map((x) => [+x.price, +x.size]).sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]));
  let c = 0; for (const [p, s] of a) { c += s; if (c >= ms) return p; } return null;
}
(async () => {
  let rows = [], cur = null;
  for (let k = 0; k < 40; k++) {
    const q = new URLSearchParams({ order_by: 'rate_per_day', position: 'DESC', page_size: '500' }); if (cur) q.set('next_cursor', cur);
    const j = await get('https://clob.polymarket.com/rewards/markets/multi?' + q); if (!j) break;
    rows.push(...(j.data || [])); cur = j.next_cursor; if (!cur || cur === 'LTE=') break;
  }
  const seen = new Set(); rows = rows.filter((r) => !seen.has(r.condition_id) && seen.add(r.condition_id));
  for (const r of rows) r.rate = rate(r);
  rows = rows.filter((r) => r.rate >= 5 && !SPORT.test(r.market_slug || '') && (r.tokens || []).length === 2);
  rows = rows.filter((r) => { const e = Date.parse((r.end_date || '').replace(' ', 'T').replace('+00', 'Z')); return e && (e - Date.now()) / 864e5 >= 3; });
  console.error('reward markets after filters', rows.length);
  const books = new Map();
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500), res = await Promise.all([0, 100, 200, 300, 400].map((o) => part.slice(o, o + 100)).filter((b) => b.length).map((b) => get('https://clob.polymarket.com/books', b.map((r) => ({ token_id: r.tokens[0].token_id })))));
    for (const r of res) for (const b of r || []) books.set(b.asset_id, b);
  }
  const U = [];
  for (const r of rows) {
    const b = books.get(r.tokens[0].token_id); if (!b) continue;
    const v = +r.rewards_max_spread / 100, ms = +r.rewards_min_size, tick = +(b.tick_size || 0.01);
    const bids = b.bids || [], asks = b.asks || [];
    const bb = cutBest(bids, ms, true), ba = cutBest(asks, ms, false); if (bb == null || ba == null) continue;
    const mid = (bb + ba) / 2; if (mid < 0.1 || mid > 0.9) continue;
    const rbb = Math.max(...bids.map((x) => +x.price)), rba = Math.min(...asks.map((x) => +x.price)); if (!(rba - rbb <= 2 * v + 1e-9)) continue;
    const S = (d) => (d >= 0 && d < v ? ((v - d) / v) ** 2 : 0);
    const qb = bids.reduce((s, x) => s + (+x.size >= ms ? S(mid - x.price) * x.size : 0), 0), qa = asks.reduce((s, x) => s + (+x.size >= ms ? S(x.price - mid) * x.size : 0), 0);
    const qo = Math.max(Math.min(qb, qa), Math.max(qb, qa) / 3);
    const d = Math.max(tick, Math.round(v / 3 / tick) * tick), size0 = Math.max(ms, Math.ceil(50 / Math.max(mid, 0.05)));
    const qu = size0 * S(d), share = qu + qo > 0 ? qu / (qu + qo) : 0, cap = size0 * (mid - d) + size0 * (1 - mid - d);
    U.push({ cid: r.condition_id, tok: r.tokens[0].token_id, tok2: r.tokens[1].token_id, slug: r.market_slug, ev: r.event_slug, rate: r.rate, v, ms, tick,
      size: Math.max(ms, 50), end: r.end_date, mid0: +mid.toFixed(4), share0: +share.toFixed(4), roc0: +(r.rate * share / Math.max(cap, 1)).toFixed(4) });
  }
  U.sort((x, y) => y.roc0 - x.roc0);
  const pick = U.slice(0, TOP); fs.writeFileSync(OUT, JSON.stringify(pick));
  console.error(`universe ${U.length} -> top ${pick.length} by roc0; pools $${Math.round(pick.reduce((s, u) => s + u.rate, 0))}/day; capital ~$${Math.round(pick.reduce((s, u) => s + u.size, 0))}`);
})();
