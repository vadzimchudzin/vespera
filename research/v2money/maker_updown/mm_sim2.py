"""Maker v2 (skeptic pass). Changes against mm_sim.py (v1):
 1. one event per taker (v1 counted the taker record and every maker record of a match as separate trades);
 2. side-aware: a taker SELL can only hit our bid, a taker BUY only our ask;
 3. post-only: our quotes never cross the book seen at decision time (bid <= best ask - 1c, ask >= best bid + 1c);
 4. queue: we get the volume the taker filled at prices strictly worse than ours (price priority; at our own level we are
    last in the queue: share `touch` of that level's volume, default 0);
 5. after a fill the side is refilled only after the latency L.
Fair value: as v1 (Binance mid + Chainlink basis, TWAP-60 variance). Control: the same maker around the market mid.
Markouts per fill: the up-equivalent market mid 10 s / 60 s later and the result."""
import pickle, bisect, math, sys, collections, statistics, random
W, TW, BN, Q, EV = pickle.load(open('cache2.pkl', 'rb'))
PHI = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
grid = {}
for a, (T, M) in BN.items():
    s0, s1 = T[0] // 1000 + 1, T[-1] // 1000
    g, j = {}, 0
    for s in range(s0, s1 + 1):
        while j + 1 < len(T) and T[j + 1] <= s * 1000: j += 1
        g[s] = M[j]
    var, lam, vs, prev = None, 0.5 ** (1 / 120), {}, None
    for s in range(s0, s1 + 1):
        m = g[s]
        if prev is not None:
            r = math.log(m / prev); var = r * r if var is None else lam * var + (1 - lam) * r * r
        prev = m; vs[s] = var
    grid[a] = (g, vs, s0, s1)
def b60(a, s):
    g = grid[a][0]; xs = [g[k] for k in range(s - 59, s + 1) if k in g]
    return sum(xs) / len(xs) if len(xs) >= 50 else None
def basis(a, s):
    tw = TW.get(a, {}); out = []
    for k in range(s - 120, s - 2, 5):
        if k in tw:
            b = b60(a, k)
            if b is not None: out.append(tw[k] - b)
    return statistics.median(out) if out else None
BASIS = {}
def fv(w, t_ms):
    a = w['asset']; s = int(t_ms // 1000)
    g, vs, s0, s1 = grid[a]
    if s not in g or vs.get(s) is None: return None
    key = (a, s // 10)
    if key not in BASIS: BASIS[key] = basis(a, s)
    bs = BASIS[key]
    if bs is None: return None
    S = g[s] + bs; sig = math.sqrt(vs[s]) * S
    tau = (w['end'] - t_ms) / 1000
    if tau <= 0: return None
    if tau >= 60: E = S; sd = sig * math.sqrt(tau - 40)
    else:
        e0 = int(w['end'] // 1000) - 60
        fixed = [g[k] + bs for k in range(e0 + 1, s + 1) if k in g]
        n_fix = len(fixed); E = (sum(fixed) + (60 - n_fix) * S) / 60
        sd = sig * math.sqrt(max(1e-9, (60 - n_fix) ** 3 / (3 * 3600)))
    if sd <= 0: return None
    return min(0.999, max(0.001, PHI((E - w['ptb_cl']) / sd)))
def book(w, t):
    T, B, A = Q.get(w['up'], ([], [], []))
    i = bisect.bisect_right(T, t) - 1
    return (B[i], A[i]) if i >= 0 else (None, None)
ready = []
for w in W.values():
    tw = TW.get(w['asset'], {})
    ps, pe = tw.get(w['start'] // 1000), tw.get(w['end'] // 1000)
    if ps is None or pe is None or w['asset'] not in grid: continue
    if (w['start'] // 1000 - 300) < grid[w['asset']][2]: continue
    w['ptb_cl'], w['fin_cl'] = ps, pe; w['y'] = 1 if pe >= ps else 0
    ready.append(w)
ready.sort(key=lambda w: w['start'])
def sim(h=0.02, L=200, size=50, cap=250, skew=0.0002, ref='fv', touch=0.0, assets=None, tfs=None, keep=None, seed=1):
    rnd = random.Random(seed); res = []; FL = []
    for w in ready:
        if assets and w['asset'] not in assets: continue
        if tfs and w['tf'] not in tfs: continue
        inv = cash = vol = reb = 0.0; nf = 0; rem = {'b': size, 'a': size}; due = {'b': 0, 'a': 0}
        for (rt, side, apx, sz, lv, wal) in EV.get(w['slug'], []):
            if rt < w['start'] or rt >= w['end']: continue
            td = rt - L
            bb, ba = book(w, td)
            if bb is None or ba is None or ba <= bb: continue
            if ref == 'fv':
                f = fv(w, td)
                if f is None: continue
            else: f = (bb + ba) / 2
            r_ = f - skew * inv
            bid = min(math.floor((r_ - h) * 100 + 1e-9) / 100, round(ba - 0.01, 2))
            ask = max(math.ceil((r_ + h) * 100 - 1e-9) / 100, round(bb + 0.01, 2))
            for k in 'ba':
                if rem[k] < size and rt >= due[k]: rem[k] = size
            if not lv: lv = [(round(apx, 4), sz)]
            q = 0.0
            if side == 'SELL' and bid >= 0.01 and inv < cap and rem['b'] > 0:
                avail = sum(z for p, z in lv if p < bid - 1e-9) + touch * sum(z for p, z in lv if abs(p - bid) <= 1e-9)
                q = min(avail, rem['b'], cap - inv); px = bid; sg = 1; k = 'b'
            elif side == 'BUY' and ask <= 0.99 and inv > -cap and rem['a'] > 0:
                avail = sum(z for p, z in lv if p > ask + 1e-9) + touch * sum(z for p, z in lv if abs(p - ask) <= 1e-9)
                q = min(avail, rem['a'], cap + inv); px = ask; sg = -1; k = 'a'
            if keep is not None and q > 0 and rnd.random() > keep: q = 0.0
            if q > 1e-9:
                inv += sg * q; cash -= sg * q * px; rem[k] -= q; due[k] = rt + L
                nf += 1; vol += q * px; reb += 0.2 * 0.07 * px * (1 - px) * q
                FL.append((w, rt, sg, px, q, f))
        res.append({'w': w, 'pnl': cash + inv * w['y'], 'reb': reb, 'nf': nf, 'vol': vol, 'inv': inv})
    return res, FL
def mid_at(w, t):
    bb, ba = book(w, t)
    return None if bb is None else (bb + ba) / 2
def markouts(FL):
    out = {}
    for lag in (10000, 60000):
        num = den = 0.0
        for (w, rt, sg, px, q, f) in FL:
            m = mid_at(w, min(rt + lag, w['end'] - 1))
            if m is None: continue
            num += sg * (m - px) * q; den += q
        out[lag] = num / den * 100 if den else None
    num = sum(sg * (w['y'] - px) * q for (w, rt, sg, px, q, f) in FL); den = sum(q for *_, q, f in FL)
    out['res'] = num / den * 100 if den else None
    return out
def tstat(xs):
    n = len(xs)
    if n < 2: return 0.0
    m = sum(xs) / n; sd = statistics.stdev(xs)
    return m / (sd / math.sqrt(n)) if sd else 0.0
def report(res, FL, label):
    by = collections.defaultdict(list)
    for r in res: by[(r['w']['asset'], r['w']['tf'])].append(r)
    tot = [r['pnl'] for r in res]
    mk = markouts(FL)
    print(f"{label}: windows {len(tot)}, fills {sum(r['nf'] for r in res)}, shares {sum(q for *_, q, f in FL):.0f}, P&L ${sum(tot):+.2f} "
          f"(t {tstat(tot):+.2f}), rebates ${sum(r['reb'] for r in res):.2f}; markout c/share +10s {mk[10000]:+.2f} +60s {mk[60000]:+.2f} res {mk['res']:+.2f}"
          if FL else f"{label}: no fills")
    for k in sorted(by):
        xs = [r['pnl'] for r in by[k]]
        print(f"    {k[0]} {k[1]:>3}: windows {len(xs):2d} fills {sum(r['nf'] for r in by[k]):5d}  P&L ${sum(xs):+8.2f}  t {tstat(xs):+.2f}  positive {sum(x > 0 for x in xs)}/{len(xs)}")
if __name__ == '__main__':
    hours = (max(w['end'] for w in ready) - min(w['start'] for w in ready)) / 3.6e6
    print('windows', len(ready), collections.Counter((w['asset'], w['tf']) for w in ready), f'~{hours:.2f} h')
    for ref in ['fv', 'mid']:
        for h in [0.01, 0.02, 0.03]:
            for L in [200, 1000]:
                report(*sim(h=h, L=L, ref=ref), f"{ref} h {h:.2f} L {L} ms touch 0")
    for ref in ['fv', 'mid']:
        report(*sim(h=0.02, L=200, ref=ref, touch=0.5), f"{ref} h 0.02 L 200 ms touch 0.5")
