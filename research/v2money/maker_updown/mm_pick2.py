"""Skeptic pass 2 on the maker (vectorised). Pick-offs: a virtual quote decided at t-L is crossed whenever the real best
price at t moves through it (best ask <= our bid, or best bid >= our ask); in reality the order that moved the book would
have traded with us, so we are filled at our price for the whole remaining size (pessimistic). Taker fills as mm_sim2
(one event per taker, side-aware, post-only, volume strictly through our price). Inventory skew 0 in this pass
(so quotes do not depend on the path); cap 250. Latency 0.2/1/3 s, halves, concentration."""
import math, collections, statistics, sys, bisect
import numpy as np
import mm_sim2 as S
from mm_sim2 import ready, EV, Q, fv, tstat, markouts
PREP = {}
def prep(w):
    if w['slug'] in PREP: return PREP[w['slug']]
    T, B, A = (np.asarray(x, dtype=float) for x in Q.get(w['up'], ([], [], [])))
    if len(T):
        keep = np.ones(len(T), bool); keep[1:] = (B[1:] != B[:-1]) | (A[1:] != A[:-1])
        T, B, A = T[keep], B[keep], A[keep]
    s0 = int(w['start'] // 1000) - 5; s1 = int(w['end'] // 1000) + 1
    F = np.array([np.nan if (f := fv(w, s * 1000 + 500)) is None else f for s in range(s0, s1)])
    PREP[w['slug']] = (T, B, A, s0, F); return PREP[w['slug']]
def quotes(w, t, L, h, ref):
    T, B, A, s0, F = prep(w)
    td = t - L; i = np.searchsorted(T, td, 'right') - 1
    ok = i >= 0; i = np.maximum(i, 0)
    bb, ba = B[i], A[i]; ok &= ba > bb
    if ref == 'fv':
        k = (td // 1000).astype(int) - s0; ok &= (k >= 0) & (k < len(F)); k = np.clip(k, 0, len(F) - 1)
        r = F[k]; ok &= ~np.isnan(r)
    else: r = (bb + ba) / 2
    bid = np.minimum(np.floor((r - h) * 100 + 1e-9) / 100, np.round(ba - 0.01, 2))
    ask = np.maximum(np.ceil((r + h) * 100 - 1e-9) / 100, np.round(bb + 0.01, 2))
    return bid, ask, ok, r
def sim(h=0.02, L=200, size=50, cap=250, ref='mid', pick=True, wins=None, assets=None, tfs=None):
    res = []; FL = []
    for w in (wins or ready):
        if assets and w['asset'] not in assets: continue
        if tfs and w['tf'] not in tfs: continue
        T, B, A, s0, F = prep(w)
        items = []
        ev = [e for e in EV.get(w['slug'], []) if w['start'] <= e[0] < w['end']]
        if ev:
            te = np.array([e[0] for e in ev], float); bid, ask, ok, r = quotes(w, te, L, h, ref)
            items += [(te[j], 1, ev[j], bid[j], ask[j], r[j]) for j in range(len(ev)) if ok[j]]
        if pick and len(T):
            m = (T >= w['start']) & (T < w['end']); Tb, Bb, Ab = T[m], B[m], A[m]
            if len(Tb):
                bid, ask, ok, r = quotes(w, Tb, L, h, ref)
                c = ok & ((Ab <= bid + 1e-9) | (Bb >= ask - 1e-9))
                for j in np.nonzero(c)[0]: items.append((Tb[j], 0, (Bb[j], Ab[j]), bid[j], ask[j], r[j]))
        items.sort(key=lambda x: (x[0], x[1]))
        inv = cash = reb = 0.0; nf = npk = 0; rem = {'b': size, 'a': size}; due = {'b': 0, 'a': 0}
        for (t, kind, e, bid, ask, f) in items:
            for k in 'ba':
                if rem[k] < size and t >= due[k]: rem[k] = size
            q = 0.0
            if kind == 0:
                nb, na = e
                if na <= bid + 1e-9 and bid >= 0.01 and inv < cap and rem['b'] > 0: q = min(rem['b'], cap - inv); px = bid; sg = 1; k = 'b'
                elif nb >= ask - 1e-9 and ask <= 0.99 and inv > -cap and rem['a'] > 0: q = min(rem['a'], cap + inv); px = ask; sg = -1; k = 'a'
                if q > 0: npk += 1
            else:
                rt, side, apx, sz, lv, wal = e
                if not lv: lv = [(round(apx, 4), sz)]
                if side == 'SELL' and bid >= 0.01 and inv < cap and rem['b'] > 0:
                    q = min(sum(z for p, z in lv if p < bid - 1e-9), rem['b'], cap - inv); px = bid; sg = 1; k = 'b'
                elif side == 'BUY' and ask <= 0.99 and inv > -cap and rem['a'] > 0:
                    q = min(sum(z for p, z in lv if p > ask + 1e-9), rem['a'], cap + inv); px = ask; sg = -1; k = 'a'
            if q > 1e-9:
                inv += sg * q; cash -= sg * q * px; rem[k] -= q; due[k] = t + L
                nf += 1; reb += 0.2 * 0.07 * px * (1 - px) * q; FL.append((w, t, sg, px, q, f))
        res.append({'w': w, 'pnl': cash + inv * w['y'], 'reb': reb, 'nf': nf, 'npk': npk, 'inv': inv})
    return res, FL
def line(res, FL, label):
    tot = [r['pnl'] for r in res]; mk = markouts(FL) if FL else {10000: 0, 60000: 0, 'res': 0}
    s = sum(tot); top = max(tot) / s if s > 0 else float('nan')
    print(f"{label}: win {len(tot)} fills {sum(r['nf'] for r in res)} (pick-offs {sum(r['npk'] for r in res)}) P&L ${s:+8.2f} t {tstat(tot):+.2f} "
          f"pos {sum(x > 0 for x in tot)}/{len(tot)} top {top:.0%} | mk10 {mk[10000]:+.2f} mk60 {mk[60000]:+.2f} res {mk['res']:+.2f} c", flush=True)
if __name__ == '__main__':
    print('windows', len(ready), flush=True)
    for ref in ['mid', 'fv']:
        line(*sim(h=0.02, L=200, ref=ref, pick=False), f"{ref} h 0.02 L  200 no-pick")
        for h in [0.01, 0.02, 0.03]:
            for L in [200, 1000, 3000]:
                line(*sim(h=h, L=L, ref=ref), f"{ref} h {h:.2f} L {L:4d} pick")
    print('-- by asset/tf, mid h 0.02 L 200 pick')
    for a in ['btc', 'eth', 'sol', 'xrp']:
        for tf in ['5m', '15m']: line(*sim(h=0.02, L=200, ref='mid', assets=[a], tfs=[tf]), f"  {a} {tf:>3}")
    half = len(ready) // 2
    print('-- halves (by window start), mid h 0.02 L 200 pick')
    line(*sim(h=0.02, L=200, ref='mid', wins=ready[:half]), '  first half ')
    line(*sim(h=0.02, L=200, ref='mid', wins=ready[half:]), '  second half')
