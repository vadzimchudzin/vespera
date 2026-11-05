#!/usr/bin/env python3
"""skeptic.py - the skeptic's standard checks on any paper-trade log (JSONL, one trade per line).

  python3 ops/skeptic.py out/trades.jsonl --pnl ex10 --weight sz --cluster slug --time T --where a=btc --where tf=5m --trials 12

Checks (each one has killed a "result" in this project before):
  * clustered t: trades inside one window/market are not independent; the t-stat uses cluster-robust errors;
  * bootstrap 95% CI over clusters;
  * stability: by UTC hour and first vs second half - an edge that lives in one hour is a story, not a rule;
  * concentration: share of P&L from the best cluster / hour / day;
  * Deflated Sharpe (Bailey & Lopez de Prado): the probability that the per-cluster Sharpe beats the best of
    --trials null strategies - take the trial count from REGISTRY.md, every variant ever tried counts.
Units: --scale multiplies P&L for printing (100 -> cents when P&L is in dollars per share)."""
import json, math, random, statistics, collections, argparse, datetime, sys
def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def nppf(p):
    lo, hi = -10.0, 10.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if ncdf(mid) < p: lo = mid
        else: hi = mid
    return (lo + hi) / 2
def clustered(xs, gs, ws=None):
    ws = ws or [1.0] * len(xs); W = sum(ws); m = sum(x * w for x, w in zip(xs, ws)) / W
    by = collections.defaultdict(float)
    for x, g, w in zip(xs, gs, ws): by[g] += w * (x - m)
    G = len(by)
    if G < 2: return m, float('nan')
    se = math.sqrt(sum(v * v for v in by.values()) * G / (G - 1)) / W
    return m, (m / se if se else float('nan'))
def deflated_sharpe(r, trials):
    T = len(r)
    if T < 3 or trials < 1: return float('nan'), float('nan')
    m = sum(r) / T; sd = statistics.pstdev(r)
    if sd == 0: return float('nan'), float('nan')
    sr = m / sd
    g3 = sum((x - m) ** 3 for x in r) / T / sd ** 3; g4 = sum((x - m) ** 4 for x in r) / T / sd ** 4
    e = 0.5772156649
    sr0 = math.sqrt(1 / (T - 1)) * ((1 - e) * nppf(1 - 1 / max(trials, 2)) + e * nppf(1 - 1 / (max(trials, 2) * math.e))) if trials > 1 else 0.0
    den = 1 - g3 * sr + (g4 - 1) / 4 * sr * sr
    return sr, ncdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(den)) if den > 0 else float('nan')
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('file'); ap.add_argument('--pnl', required=True); ap.add_argument('--cluster', default=None)
    ap.add_argument('--time', default=None, help='field with ms or s epoch'); ap.add_argument('--where', action='append', default=[])
    ap.add_argument('--trials', type=int, default=1); ap.add_argument('--scale', type=float, default=1.0); ap.add_argument('--json', action='store_true')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--weight', default=None, help='size field: the mean becomes per unit of size (sum pnl*w / sum w)')
    a = ap.parse_args(argv)
    cond = [w.split('=', 1) for w in a.where]
    rows = []
    for l in open(a.file):
        try: r = json.loads(l)
        except Exception: continue
        if r.get(a.pnl) is None or any(str(r.get(k)) != v for k, v in cond): continue
        rows.append(r)
    if len(rows) < 2: print('not enough trades', len(rows)); return 1
    xs = [float(r[a.pnl]) for r in rows]
    ws = [float(r.get(a.weight) or 0) for r in rows] if a.weight else [1.0] * len(rows)
    gs = [r.get(a.cluster) if a.cluster else i for i, r in enumerate(rows)]
    ts = None
    if a.time:
        ts = [float(r[a.time]) for r in rows]; ts = [t * 1000 if t < 1e12 else t for t in ts]
    n = len(xs); m, t_cl = clustered(xs, gs, ws)
    _, t_naive = clustered(xs, list(range(n)), ws)
    by = collections.defaultdict(lambda: [0.0, 0.0])
    for x, g, w in zip(xs, gs, ws): by[g][0] += x * w; by[g][1] += w
    keys = list(by); sums = [by[k][0] for k in keys]; wsum = [by[k][1] for k in keys]
    rnd = random.Random(a.seed); boots = []
    for _ in range(1000):
        s = [rnd.randrange(len(keys)) for _ in keys]
        tot = sum(wsum[i] for i in s); boots.append(sum(sums[i] for i in s) / tot if tot else 0.0)
    boots.sort(); ci = (boots[25], boots[974])
    total = sum(sums)
    out = {'n': n, 'clusters': len(keys), 'mean': m * a.scale, 't_naive': t_naive, 't_clustered': t_cl, 'ci95': [c * a.scale for c in ci],
           'total': total * a.scale, 'top_cluster_share': (max(sums) / total if total > 0 else None)}
    if ts:
        hr = collections.defaultdict(list); dy = collections.defaultdict(float)
        for x, t, w in zip(xs, ts, ws):
            d = datetime.datetime.fromtimestamp(t / 1000, datetime.timezone.utc)
            hr[d.strftime('%Y-%m-%d %H')].append((x, w)); dy[d.strftime('%Y-%m-%d')] += x * w
        wm = lambda v: sum(x * w for x, w in v) / sum(w for _, w in v) if sum(w for _, w in v) else 0.0
        out['hours'] = {h: {'n': len(v), 'mean': wm(v) * a.scale} for h, v in sorted(hr.items())}
        out['positive_hours'] = sum(wm(v) > 0 for v in hr.values()) / len(hr)
        out['top_hour_share'] = max(sum(x * w for x, w in v) for v in hr.values()) / total if total > 0 else None
        out['top_day_share'] = max(dy.values()) / total if total > 0 and len(dy) > 1 else None
        order = sorted(range(n), key=lambda i: ts[i]); h = n // 2
        out['halves'] = [wm([(xs[i], ws[i]) for i in order[:h]]) * a.scale, wm([(xs[i], ws[i]) for i in order[h:]]) * a.scale]
    sr, dsr = deflated_sharpe(sums, a.trials)
    out['sharpe_per_cluster'] = sr; out['deflated_sharpe_prob'] = dsr; out['trials'] = a.trials
    if a.json: print(json.dumps(out)); return 0
    f = lambda v: 'n/a' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:+.2f}'
    print(f"trades {n}, clusters {len(keys)}: mean {f(out['mean'])} (95% CI {f(out['ci95'][0])}..{f(out['ci95'][1])}), t naive {f(t_naive)}, t clustered {f(t_cl)}")
    share = lambda v: 'n/a' if v is None else format(v, '.0%')
    print(f"total {f(out['total'])}; best cluster gives {share(out['top_cluster_share'])} of it")
    if ts:
        print(f"halves (by time): {f(out['halves'][0])} / {f(out['halves'][1])}; positive hours {out['positive_hours']:.0%}; "
              f"best hour {share(out['top_hour_share'])} of P&L; best day {share(out['top_day_share'])}")
        print('by hour: ' + ', '.join(f"{h[-2:]}h {v['mean']:+.2f} (n {v['n']})" for h, v in out['hours'].items()))
    print(f"Deflated Sharpe over {a.trials} trial(s): per-cluster Sharpe {f(sr)}, probability the edge is real {'n/a' if math.isnan(dsr) else format(dsr, '.0%')}")
    return 0
if __name__ == '__main__': sys.exit(main())
