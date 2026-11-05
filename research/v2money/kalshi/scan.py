"""Kalshi vs Polymarket game-winner arbitrage scanner (read-only, public data). Every 120 s: Kalshi open game events ->
Polymarket moneyline (slug league-c1-c2-date) -> both books -> cost of YES(team) on one venue + other team on the other, with fees."""
import json, time, urllib.request, urllib.parse, os
K = 'https://api.elections.kalshi.com/trade-api/v2/'; G = 'https://gamma-api.polymarket.com/'; C = 'https://clob.polymarket.com/'
LG = {'KXNBAGAME': 'nba', 'KXNHLGAME': 'nhl', 'KXNFLGAME': 'nfl', 'KXNCAAFGAME': 'cfb', 'KXNCAAMBGAME': 'cbb'}
MON = {m: i + 1 for i, m in enumerate('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split())}
def get(url, body=None):
    for i in range(3):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'User-Agent': 'vespera-research', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
        except Exception: time.sleep(2 * (i + 1))
    return None
fk = lambda p: 0.07 * p * (1 - p); fp = lambda p: 0.05 * p * (1 - p)
cache = json.load(open('map.json')) if os.path.exists('map.json') else {}
def pm_map(series, ev):
    t = ev['event_ticker']
    if t in cache: return cache[t]
    codes = [m['ticker'].rsplit('-', 1)[1] for m in ev['markets']]; tail = t.split('-', 1)[1]
    yy, mon, dd = tail[:2], tail[2:5], tail[5:7]; date = f'20{yy}-{MON.get(mon, 0):02d}-{dd}'
    order = sorted(codes, key=lambda c: tail[7:].find(c))
    res = None
    for c1, c2 in (order, order[::-1]):
        d = get(G + 'events?' + urllib.parse.urlencode({'slug': f'{LG[series]}-{c1.lower()}-{c2.lower()}-{date}'}))
        if d:
            m = next((x for x in d[0].get('markets', []) if x.get('sportsMarketType') == 'moneyline'), None)
            if m: res = {'slug': d[0]['slug'], 'toks': dict(zip([c1, c2], json.loads(m['clobTokenIds']))), 'q': m['question']}; break
    cache[t] = res; json.dump(cache, open('map.json', 'w')); return res
while True:
    t0 = time.time(); rows = []; pairs = []
    for s in LG:
        d = get(K + 'events?' + urllib.parse.urlencode({'status': 'open', 'series_ticker': s, 'with_nested_markets': 'true', 'limit': 200}))
        for ev in (d or {}).get('events', []):
            if len(ev.get('markets', [])) != 2: continue
            mp = pm_map(s, ev)
            if mp: pairs.append((s, ev, mp))
    toks = [tk for _, _, mp in pairs for tk in mp['toks'].values()]
    books = {}
    for i in range(0, len(toks), 100):
        r = get(C + 'books', [{'token_id': x} for x in toks[i:i + 100]]) or []
        for b in r: books[b['asset_id']] = b
    def best(tok):
        b = books.get(tok); a = b and b.get('asks')
        if not a: return None, 0
        p = min(float(x['price']) for x in a); return p, sum(float(x['size']) for x in a if float(x['price']) == p)
    for s, ev, mp in pairs:
        km = {m['ticker'].rsplit('-', 1)[1]: m for m in ev['markets']}
        c = list(mp['toks'])
        for x, y in ((c[0], c[1]), (c[1], c[0])):
            ka = float(km[x].get('yes_ask_dollars') or 0); ks = float(km[x].get('yes_ask_size_fp') or 0)
            pa, ps = best(mp['toks'][y])
            if not ka or pa is None or ka >= 1: continue
            cost = ka + pa + fk(ka) + fp(pa)
            rows.append({'ev': ev['event_ticker'], 'k_yes': x, 'pm': y, 'ka': ka, 'pa': pa, 'cost': round(cost, 4), 'sz': round(min(ks, ps), 1),
                         'kv': float(km[x].get('volume_24h_fp') or 0)})
    with open('scan.jsonl', 'a') as f: f.write(json.dumps({'t': int(t0), 'n_pairs': len(pairs), 'n_kalshi': len(cache), 'rows': rows}) + '\n')
    time.sleep(max(5, 120 - (time.time() - t0)))
