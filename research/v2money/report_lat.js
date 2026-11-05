// report_lat.js — summary of latbot paper trades: per asset/timeframe, per-share edge after fees, window-clustered t.
// Usage: node report_lat.js out [sinceISO]
'use strict';
const fs = require('node:fs');
const D = process.argv[2] || 'out', since = process.argv[3] ? Date.parse(process.argv[3]) : 0;
const rows = fs.existsSync(`${D}/trades.jsonl`) ? fs.readFileSync(`${D}/trades.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.T >= since) : [];
if (!rows.length) { console.log('no trades yet'); process.exit(0); }
const tw = (g, f) => { const w = new Map(); for (const r of g) w.set(r.slug, (w.get(r.slug) || 0) + f(r)); const x = [...w.values()], n = x.length; if (n < 3) return NaN;
  const m = x.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return m / (sd / Math.sqrt(n)); };
const hrs = (Math.max(...rows.map((r) => r.T)) - Math.min(...rows.map((r) => r.T))) / 3.6e6;
console.log(`${rows.length} paper trades over ${hrs.toFixed(1)} h; Binance receive median ${rows.map((r) => r.recv).sort((a, b) => a - b)[rows.length >> 1]} ms`);
const groups = new Map(); for (const r of rows) { const k = `${r.a} ${r.tf}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
for (const [k, g] of [...groups].sort()) {
  const s = g.reduce((a, r) => a + r.sz, 0), sum = (f) => g.reduce((a, r) => a + f(r), 0);
  console.log(`  ${k.padEnd(7)} n=${String(g.length).padStart(5)}  edge@10s ${(100 * sum((r) => r.e10 * r.sz) / s).toFixed(2).padStart(6)}c (t ${tw(g, (r) => r.e10 * r.sz).toFixed(2)})` +
    `  exit@10s ${(100 * sum((r) => r.ex10 * r.sz) / s).toFixed(2).padStart(6)}c (t ${tw(g, (r) => r.ex10 * r.sz).toFixed(2)})  exit@60s ${(100 * sum((r) => (r.ex60 ?? NaN) * r.sz) / s).toFixed(2).padStart(6)}c  @res ${(100 * sum((r) => r.ey * r.sz) / s).toFixed(2).padStart(6)}c` +
    `  $ exit@10s ${sum((r) => r.ex10 * r.sz).toFixed(1).padStart(8)}  $/day ${(sum((r) => r.ex10 * r.sz) / Math.max(hrs, 1e-9) * 24).toFixed(0)}`);
}
