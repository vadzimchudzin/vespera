"""Kalshi x Polymarket game-winner gaps from scan.jsonl: per snapshot the cheapest cross-venue pair (YES team on Kalshi +
the other team on Polymarket, taker fees on both sides; Kalshi 0.07*p*(1-p), Polymarket sports 0.05*p*(1-p))."""
import json, collections, statistics, sys
S = [json.loads(l) for l in open('scan.jsonl')]
print('snapshots', len(S), 'span', round((S[-1]['t'] - S[0]['t']) / 3600, 2), 'h; pairs per snapshot', statistics.median(s['n_pairs'] for s in S))
best = collections.defaultdict(list)     # (event, k_yes) -> [(t, cost, size)]
allc = []
for s in S:
    for r in s['rows']:
        best[(r['ev'], r['k_yes'])].append((s['t'], r['cost'], r['sz'], r['ka'], r['pa']))
        allc.append(r['cost'])
allc.sort()
q = lambda p: allc[int(p * (len(allc) - 1))]
print('cost incl. fees: min %.4f p1 %.4f p5 %.4f p25 %.4f median %.4f' % (allc[0], q(.01), q(.05), q(.25), q(.5)))
for th in [1.0, 1.005, 1.01, 1.02]:
    n = sum(c < th for c in allc); print(f'  rows with cost < {th}: {n} of {len(allc)}')
arb = [(k, x) for k, v in best.items() for x in v if x[1] < 1.0]
print('sub-1 rows (event, k_yes, t, cost, size, ka, pa):')
for k, x in sorted(arb, key=lambda z: z[1][1])[:15]: print('  ', k, x)
# persistence: how many consecutive snapshots a pair stays under 1.00
runs = []
for k, v in best.items():
    run = 0
    for (t, c, *_ ) in v:
        if c < 1.0: run += 1
        elif run: runs.append(run); run = 0
    if run: runs.append(run)
print('sub-1 runs (snapshots of 2 min):', collections.Counter(runs).most_common(8))
# no-fee raw gap (ka + pa) for reference
raw = sorted(x[3] + x[4] for v in best.values() for x in v)
print('raw ka+pa: min %.3f, share < 1.00: %.3f' % (raw[0], sum(r < 1 for r in raw) / len(raw)))
by_lg = collections.defaultdict(list)
for k, v in best.items():
    for x in v: by_lg[k[0].split('-')[0]].append(x[1])
for lg, v in sorted(by_lg.items()): print(f'  {lg}: rows {len(v)}, min cost {min(v):.4f}, median {statistics.median(v):.4f}')
