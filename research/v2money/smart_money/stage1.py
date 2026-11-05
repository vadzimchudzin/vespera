import json, glob, numpy as np, datetime as dt
import pandas as pd
def spearmanr(a,b):
    r=pd.Series(a).rank().corr(pd.Series(b).rank()); n=len(a); t=r*((n-2)/(1-r*r))**0.5; return r, t
def ts(y, m, d): return int(dt.datetime(y, m, d, tzinfo=dt.timezone.utc).timestamp())
CUT = [ts(2026, 8, 3), ts(2026, 9, 4), ts(2026, 10, 5), ts(2026, 11, 5)]
rows = []
for f in glob.glob('pnl/*.json'):
    d = json.load(open(f)); P = d.get('pnl') or []
    if len(P) < 20: continue
    t = np.array([x['timestamp'] for x in P]); 
    def at(c, k):
        i = np.searchsorted(t, c, side='right') - 1
        return P[i][k] if i >= 0 else 0.0
    r = {'w': f[4:-5]}
    for j in range(3):
        a, b = CUT[j], CUT[j + 1]
        r[f'p{j}'] = (at(b, 'position_pnl') or 0) - (at(a, 'position_pnl') or 0)
        r[f'v{j}'] = (at(b, 'volume_usdc') or 0) - (at(a, 'volume_usdc') or 0)
        r[f'n{j}'] = (at(b, 'trade_count') or 0) - (at(a, 'trade_count') or 0)
    rows.append(r)
print('wallets with series', len(rows))
for j in (0, 1):
    E = [r for r in rows if r[f'v{j}'] >= 20000 and r[f'v{j+1}'] >= 20000 and r[f'n{j}'] >= 50 and r[f'n{j+1}'] >= 50]
    x = np.array([r[f'p{j}'] / r[f'v{j}'] for r in E]); y = np.array([r[f'p{j+1}'] / r[f'v{j+1}'] for r in E]); py = np.array([r[f'p{j+1}'] for r in E])
    rho, pv = spearmanr(x, y)
    print(f'\nperiod {j}->{j+1}: n={len(E)} spearman ROI rho={rho:.3f} t={pv:.1f}')
    q = np.quantile(x, np.linspace(0, 1, 11))
    for k in range(10):
        m = (x >= q[k]) & (x <= q[k + 1]) if k == 9 else (x >= q[k]) & (x < q[k + 1])
        print(f'  decile {k}: ROI_sel {np.median(x[m])*100:+6.2f}%  next ROI mean {y[m].mean()*100:+6.2f}% med {np.median(y[m])*100:+6.2f}%  share>0 {np.mean(y[m]>0):.2f}  next PnL sum ${py[m].sum()/1e3:+8.0f}k')
