"""Smart-money stage 1: wallet pool by volume, daily PnL series and volume per period (Data API v2)."""
import json, os, time, urllib.request, urllib.parse, concurrent.futures as cf
B = 'https://data-api.polymarket.com/v2/'
def get(path, **q):
    url = B + path + '?' + urllib.parse.urlencode({k: v for k, v in q.items() if v is not None})
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'vespera-research'}), timeout=30) as r: return json.load(r)
        except Exception as e:
            if hasattr(e, 'code') and e.code in (400, 404): return None
            time.sleep(1.5 * (i + 1))
    return None
pool = {}
for tp in ('month', 'all'):
    cur = None
    for page in range(3):
        d = get('leaderboard', time_period=tp, sort_by='VOLUME', limit=1000, cursor=cur)
        if not d: break
        for x in d['data']: pool.setdefault(x['user_id'], {'name': x.get('user_name'), 'lb': {}})['lb'][tp] = {'pnl': x['pnl'], 'vol': x['volume'], 'rank': x['rank']}
        cur = (d.get('pagination') or {}).get('next_cursor')
        if not cur: break
json.dump(pool, open('pool.json', 'w'))
print('pool', len(pool), flush=True)
A0, SPLIT, B1 = None, int(time.mktime((2026, 10, 6, 0, 0, 0, 0, 0, 0))) - time.timezone, int(time.time())
os.makedirs('pnl', exist_ok=True)
def one(w):
    f = f'pnl/{w}.json'
    if os.path.exists(f): return
    p = get('user-pnl', user=w, interval='all', fidelity='1d')
    va = get('user-volume', user=w, start=1787000000, end=SPLIT); vb = get('user-volume', user=w, start=SPLIT, end=B1)
    json.dump({'pnl': p and p['data']['points'], 'va': va and va['data'], 'vb': vb and vb['data']}, open(f, 'w'))
with cf.ThreadPoolExecutor(8) as ex:
    for i, _ in enumerate(ex.map(one, list(pool))):
        if i % 200 == 0: print(i, time.strftime('%H:%M:%S'), flush=True)
print('done', flush=True)
