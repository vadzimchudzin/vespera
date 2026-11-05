"""Loader v2 for the maker study. Fixes the v1 fill source: RTDS activity publishes one record per party of a match
(the taker with a fee field, plus one record per maker order hit), and v1 used every record as a separate trade.
v2 keeps one event per taker: (rt, up-equivalent side, average price, size, levels hit [(up price, size)]).
Also keeps the up-equivalent best bid/ask with their sizes."""
import orjson, subprocess, collections, glob, pickle, sys, time, os
DAY = os.environ.get('COLL_DAY', 'coll/2026-11-05')   # one day folder written by scripts/collect.js
def lines(kind):
    for f in sorted(glob.glob(f'{DAY}/{kind}-*.jsonl.br*')):
        p = subprocess.Popen(['brotli', '-dc', f], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        for l in p.stdout:
            try: yield orjson.loads(l)
            except Exception: continue
        p.wait()
SYM = {'BTCUSDT': 'btc', 'ETHUSDT': 'eth', 'SOLUSDT': 'sol', 'XRPUSDT': 'xrp'}
CLS = {'btc/usd': 'btc', 'eth/usd': 'eth', 'sol/usd': 'sol', 'xrp/usd': 'xrp'}
def load(tfs=('5m', '15m')):
    W = {}
    for r in lines('meta'):
        d = r['d']
        if d.get('kind') != 'window' or d.get('tf') not in tfs: continue
        w = W.setdefault(d['slug'], {})
        w.update({k: d.get(k) for k in ['slug', 'asset', 'tf', 'up', 'down', 'start', 'end', 'ptb', 'fin', 'outcome', 'rule', 'rewards']})
    tw = collections.defaultdict(dict)
    for r in lines('chainlink'):
        d = r['d']; p = d.get('payload') or {}
        a = CLS.get(p.get('symbol'))
        if not a: continue
        rows = p.get('data') if isinstance(p.get('data'), list) else [p]
        for x in rows:
            if 'timestamp' in x and 'value' in x: tw[a][int(x['timestamp']) // 1000] = float(x['value'])
    bn = collections.defaultdict(lambda: ([], []))
    for r in lines('binance-book'):
        d = r['d']; a = SYM.get(d.get('s'))
        if not a: continue
        t, m = bn[a]; t.append(r['rt']); m.append((float(d['b']) + float(d['a'])) / 2)
    toks = {}
    for w in W.values():
        toks[w['up']] = (w['slug'], 'up'); toks[w['down']] = (w['slug'], 'down')
    q = collections.defaultdict(lambda: ([], [], []))
    for r in lines('clob'):
        rt = r['rt']; d = r['d']
        for x in (d if isinstance(d, list) else [d]):
            if 'price_changes' in x:
                for c in x['price_changes']:
                    k = toks.get(c.get('asset_id'))
                    if not k or c.get('best_bid') is None: continue
                    bb, ba = float(c['best_bid'] or 0), float(c['best_ask'] or 1)
                    if k[1] == 'down': bb, ba = 1 - ba, 1 - bb
                    s = q[W[k[0]]['up']]; s[0].append(rt); s[1].append(bb); s[2].append(ba)
            elif 'bids' in x and x.get('asset_id') in toks:
                k = toks[x['asset_id']]
                bids = [float(b['price']) for b in x['bids']]; asks = [float(a['price']) for a in x['asks']]
                bb = max(bids) if bids else 0.0; ba = min(asks) if asks else 1.0
                if k[1] == 'down': bb, ba = 1 - ba, 1 - bb
                s = q[W[k[0]]['up']]; s[0].append(rt); s[1].append(bb); s[2].append(ba)
    tx = collections.defaultdict(list)
    for r in lines('fills'):
        p = (r['d'] or {}).get('payload') or {}
        k = toks.get(p.get('asset'))
        if not k: continue
        px = float(p['price']); sz = float(p['size']); side = p.get('side')
        if k[1] == 'down': px = 1 - px; side = {'BUY': 'SELL', 'SELL': 'BUY'}.get(side, side)
        tx[(k[0], p.get('transactionHash'))].append((r['rt'], px, sz, side, 'fee' in p, p.get('proxyWallet')))
    ev = collections.defaultdict(list); stats = collections.Counter()
    for (slug, h), recs in tx.items():
        tk = [x for x in recs if x[4]]
        if len(tk) != 1:
            stats['skip_%d_takers' % min(len(tk), 2)] += 1
            continue
        t = tk[0]; mk = [x for x in recs if not x[4]]
        lv = [(round(x[1], 4), x[2]) for x in mk if x[3] != t[3]]
        stats['ok'] += 1
        ev[slug].append((min(x[0] for x in recs), t[3], t[1], t[2], lv, t[5]))
    for v in ev.values(): v.sort(key=lambda e: e[0])
    print('taker events', dict(stats), file=sys.stderr)
    return W, dict(tw), {a: v for a, v in bn.items()}, dict(q), dict(ev)
if __name__ == '__main__':
    t = time.time(); out = load()
    pickle.dump(out, open('cache2.pkl', 'wb'))
    W, tw, bn, q, ev = out
    print('loaded', round(time.time() - t), 's; windows', len(W), 'taker events', sum(len(v) for v in ev.values()))
