"""Smart-money stage 2: does copying period-B winners pay in period C (Oct 5 - Nov 5)?
Each BUY of a group wallet (>= $50) is copied: entry at the first 5-min price bucket at least DELAY s after the trade
(plus a taker fee 0.05*p*(1-p) and 1c slippage), exit at the resolution payout (or the last price if unresolved).
Wallet-clustered statistics; mid and bottom deciles are the controls. Variant 'own' = entry at the wallet's own price."""
import json, os, math, bisect, collections, sys
G = json.load(open('groups.json')); RES = json.load(open('res.json'))
PX = {}
def path(tok):
    if tok not in PX:
        f = f'px3/{tok[:40]}.json'
        d = json.load(open(f)) if os.path.exists(f) else None
        PX[tok] = sorted((int(x['t']), float(x['p'])) for x in d) if d else []
    return PX[tok]
def payout(cond, idx):
    r = RES.get(cond)
    if not r or r.get('status') != 'resolved' or not r.get('payouts'): return None
    p = r['payouts']; s = sum(p)
    return p[idx] / s if s and idx < len(p) else None
def fee(p): return 0.05 * p * (1 - p)
def run(delay, own=False, slip=0.01, fade=False):
    out = {}
    for g, ws in G.items():
        rows = []
        for w in ws:
            try: tr = json.load(open(f'tr/{w}.json'))
            except Exception: continue
            for x in tr:
                if x['side'] != 'BUY': continue
                tok, cond, idx, t = x['token_id'], x['condition_id'], int(x.get('outcome_index', 0)), int(x['timestamp'])
                pth = path(tok)
                y = payout(cond, idx)
                if y is None: continue                                   # resolved markets only
                res = True
                if own: e = float(x['price'])
                else:
                    if not pth: continue
                    i = bisect.bisect_left(pth, (t + delay, -1))
                    if i >= len(pth) or pth[i][0] > t + delay + 3600: continue
                    e = pth[i][1]
                if fade: e, y = 1 - e, 1 - y                              # buy the other side
                e += 0 if own else slip
                if not (0.02 <= e <= 0.98): continue
                usd = float(x['size']) * float(x['price'])
                rows.append({'w': w, 'cond': cond, 'e': e, 'y': y, 'res': res, 'usd': usd, 'pnl_sh': y - e - fee(e), 't': t})
        out[g] = rows
    return out
def summarize(rows, label):
    byw = collections.defaultdict(lambda: [0.0, 0.0, 0])
    for r in rows:
        sh = 100 / r['e']                                      # $100 per copied trade
        b = byw[r['w']]; b[0] += sh * r['pnl_sh']; b[1] += 100; b[2] += 1
    roi = [b[0] / b[1] for b in byw.values() if b[2] >= 5]
    n = len(roi)
    m = sum(roi) / n if n else float('nan')
    sd = (sum((x - m) ** 2 for x in roi) / (n - 1)) ** .5 if n > 1 else float('nan')
    pooled = sum(b[0] for b in byw.values()) / max(1, sum(b[1] for b in byw.values()))
    resn = sum(r['res'] for r in rows)
    med = sorted(roi)[n // 2] if n else float('nan')
    return f"{label:8s} trades {len(rows):6d} (resolved {resn / max(1, len(rows)):.0%}) wallets {n:3d}  pooled ROI {pooled:+.2%}  wallet mean {m:+.2%} (t {m / (sd / n ** .5) if n > 1 and sd > 0 else float('nan'):+.2f})  median {med:+.2%}  positive {sum(x > 0 for x in roi) / max(1, n):.0%}"
if __name__ == '__main__':
    for name, kw in [('own price (their edge)', dict(delay=0, own=True)), ('copy +5 min', dict(delay=300)), ('copy +1 h', dict(delay=3600)), ('copy +1 day', dict(delay=86400)),
                     ('fade +5 min', dict(delay=300, fade=True)), ('fade +1 h', dict(delay=3600, fade=True))]:
        print('==', name)
        R = run(**kw)
        for g in ['top', 'mid', 'bottom']: print(summarize(R[g], g))
