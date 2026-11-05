"""Addendum B (frozen 2026-11-05 16:59 UTC): quiet filter - trade only when the asset had <= 5 jumps in the prior 300 s.
Post-freeze trades only; per asset/tf: filtered exit@10s > 0 with window-clustered t > 2.5 on >= 300 trades, edge@res > 0."""
import json, bisect, collections, math, statistics, datetime, os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
FREEZE = int(datetime.datetime(2026, 11, 5, 16, 59, tzinfo=datetime.timezone.utc).timestamp() * 1000)
ev = collections.defaultdict(list)
for l in open(os.path.join(OUT, 'events.jsonl')):
    try: e = json.loads(l)
    except Exception: continue
    ev[e['a']].append(e['T'])
for v in ev.values(): v.sort()
tr = []
for l in open(os.path.join(OUT, 'trades.jsonl')):
    try: t = json.loads(l)
    except Exception: continue
    if t['T'] < FREEZE or t.get('ex10') is None: continue
    v = ev[t['a']]; t['j5'] = bisect.bisect_left(v, t['T']) - bisect.bisect_left(v, t['T'] - 300000)
    tr.append(t)
def ct(rows, key):
    by = collections.defaultdict(list)
    for r in rows:
        if r.get(key) is not None: by[r['slug']].append(r[key])
    xs = [x for v in by.values() for x in v]
    if len(xs) < 2 or len(by) < 2: return (sum(xs) / len(xs) if xs else float('nan')), float('nan')
    m = sum(xs) / len(xs); n = len(xs); G = len(by)
    s = sum((sum(x - m for x in v)) ** 2 for v in by.values())
    se = math.sqrt(s * G / (G - 1)) / n
    return m, (m / se if se else float('nan'))
span = (max(t['T'] for t in tr) - FREEZE) / 3.6e6 if tr else 0
print(f'post-freeze trades {len(tr)} over {span:.2f} h; jumps/h by asset:', {a: round(sum(x >= FREEZE for x in v) / max(span, 1e-9)) for a, v in ev.items()})
print('share of trades passing the filter (j5 <= 5):', round(sum(t['j5'] <= 5 for t in tr) / max(1, len(tr)), 3))
for a in ['btc', 'eth', 'sol', 'xrp']:
    for tf in ['5m', '15m']:
        rows = [t for t in tr if t['a'] == a and t['tf'] == tf]
        q = [t for t in rows if t['j5'] <= 5]
        m, t_ = ct(rows, 'ex10'); mq, tq = ct(q, 'ex10'); ey = ct(q, 'ey')[0]
        ok = len(q) >= 300 and mq > 0 and tq > 2.5 and ey > 0
        print(f'  {a} {tf:>3}: all n {len(rows):4d} exit@10s {m * 100:+.2f}c (t {t_:+.2f}) | quiet n {len(q):4d} exit@10s {mq * 100:+.2f}c (t {tq:+.2f}) edge@res {ey * 100:+.2f}c -> {"PASS" if ok else "fail"}')
