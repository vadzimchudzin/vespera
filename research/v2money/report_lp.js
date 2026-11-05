// report_lp.js — LP paper sim summary: rewards (agg / pessimistic share), mark-to-market, net, concentration.
// Usage: node report_lp.js lpout
'use strict';
const fs = require('node:fs');
const D = process.argv[2] || 'lpout';
const S = JSON.parse(fs.readFileSync(`${D}/state.json`, 'utf8')), U = JSON.parse(fs.readFileSync(`${D}/universe.json`, 'utf8'));
const M = fs.readFileSync(`${D}/minutes.jsonl`, 'utf8').trim().split('\n'); const t0 = JSON.parse(M[0]).t, t1 = JSON.parse(M[M.length - 1]).t, h = (t1 - t0) / 3.6e6;
console.log(`${D}: ${h.toFixed(1)} h, ${U.length} markets`);
for (const v of Object.keys(S.m[U[0].cid])) {
  let rA = 0, rP = 0, mtm = 0, cap = 0, best = 0; const per = [];
  for (const u of U) { const x = S.m[u.cid][v], mk = S.mk[u.cid] ?? S.mid[u.cid]; if (mk == null) continue; const m = x.cash + x.inv * mk;
    rA += x.rA; rP += x.rP; mtm += m; cap += x.capMax; per.push(x.rP + m); }
  const net = rP + mtm, top = Math.max(...per);
  console.log(`  [${v}] per day: rewards agg ${(rA / h * 24).toFixed(0)} pess ${(rP / h * 24).toFixed(0)} | MTM ${(mtm / h * 24).toFixed(0)} | net (pess) ${(net / h * 24).toFixed(0)}` +
    ` | capital ~${cap.toFixed(0)} | top market ${net > 0 ? (100 * top / net).toFixed(0) + '%' : 'n/a'} of net`);
}
