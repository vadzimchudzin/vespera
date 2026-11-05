"""Reality check of LP economics from public data: wallets active in the LP universe markets -> all-time user-stats
(reward income vs trade P&L). Read-only, public Data API v2."""
import json, urllib.request, collections, time, statistics, sys
API = 'https://data-api.polymarket.com/v2/'
def get(u):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + u, headers={'User-Agent': 'vespera-research'}), timeout=30) as r: return json.load(r)
        except Exception as e: time.sleep(1 + i)
    return None
U = json.load(open(sys.argv[1])); L = U if isinstance(U, list) else (U.get('markets') or list(U.values()))
L = sorted(L, key=lambda m: -m['rate'])[:int(sys.argv[2]) if len(sys.argv) > 2 else 60]
seen = collections.defaultdict(set)
for m in L:
    d = get(f"trades?condition={m['cid']}&taker_only=false&limit=1000") or {}
    for r in d.get('data', []): seen[r['proxy_wallet']].add(m['cid'])
    time.sleep(0.1)
top = sorted(seen, key=lambda w: -len(seen[w]))[:int(sys.argv[3]) if len(sys.argv) > 3 else 80]
rows = []
for w in top:
    s = ((get(f'user-stats?user={w}') or {}).get('data') or {}).get('all_time_pnl') or {}
    if not s: continue
    rows.append({'w': w, 'mk': len(seen[w]), 'rew': s.get('reward_income') or 0, 'reb': s.get('maker_rebate') or 0, 'trade': s.get('trade_pnl') or 0,
                 'pos': s.get('position_pnl') or 0, 'econ': s.get('economic_pnl') or 0})
    time.sleep(0.1)
json.dump(rows, open('lp_reality.json', 'w'))
lp = [r for r in rows if r['rew'] >= 500]
print(f'markets scanned {len(L)}, wallets seen {len(seen)}, stats for {len(rows)}, with reward income >= $500: {len(lp)}')
if lp:
    print(f"  reward income total ${sum(r['rew'] for r in lp):,.0f}; position P&L total ${sum(r['pos'] for r in lp):,.0f}; economic P&L total ${sum(r['econ'] for r in lp):,.0f}")
    print(f"  economic P&L > 0: {sum(r['econ'] > 0 for r in lp)}/{len(lp)}; position P&L > 0: {sum(r['pos'] > 0 for r in lp)}/{len(lp)}")
    big = [r for r in lp if r['rew'] >= 20000]
    print(f"  big LPs (reward income >= $20k): {len(big)}; economic > 0: {sum(r['econ'] > 0 for r in big)}; median position P&L / rewards {statistics.median(r['pos'] / r['rew'] for r in big) if big else float('nan'):+.2f}")
    for r in sorted(lp, key=lambda r: -r['rew'])[:12]:
        print(f"    {r['w'][:10]} markets {r['mk']:2d} rewards ${r['rew']:>10,.0f} rebates ${r['reb']:>8,.0f} position P&L ${r['pos']:>12,.0f} economic ${r['econ']:>12,.0f}")
