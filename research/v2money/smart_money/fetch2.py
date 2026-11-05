"""Smart-money stage 2 data: period-C trades (Oct 5 - Nov 5) of wallets picked on period B (Sep 4 - Oct 5) ROI:
top decile (followed), bottom decile and a middle sample (controls); price paths (5-min buckets) and resolutions."""
import json, os, time, random, urllib.request, urllib.parse, concurrent.futures as cf
exec(open('stage1.py').read().split("print('wallets with series'")[0])   # rows, CUT
B = 'https://data-api.polymarket.com/v2/'
def get(path, **q):
    url = B + path + '?' + urllib.parse.urlencode({k: v for k, v in q.items() if v is not None})
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'vespera-research'}), timeout=30) as r: return json.load(r)
        except Exception as e:
            if getattr(e, 'code', None) in (400, 404): return None
            time.sleep(1.5 * (i + 1))
    return None
E = [r for r in rows if r['v1'] >= 50000 and r['n1'] >= 50 and r['v2'] >= 1000]
E.sort(key=lambda r: r['p1'] / r['v1']); n = len(E); random.seed(7)
groups = {'top': E[-max(1, n // 10):][-80:], 'bottom': E[:max(1, n // 10)][:80], 'mid': random.sample(E[n // 3: 2 * n // 3], min(80, n // 3))}
json.dump({g: [r['w'] for r in v] for g, v in groups.items()}, open('groups.json', 'w'))
print({g: len(v) for g, v in groups.items()}, flush=True)
os.makedirs('tr', exist_ok=True)
def trades(w):
    f = f'tr/{w}.json'
    if os.path.exists(f): return
    out, cur = [], None
    for _ in range(4):
        d = get('trades', user=w, start=CUT[2], end=CUT[3], limit=1000, cursor=cur)
        if not d: break
        out += [x for x in d['data'] if float(x['size']) * float(x['price']) >= 50]
        cur = (d.get('pagination') or {}).get('next_cursor')
        if not cur: break
    json.dump(out, open(f, 'w'))
ws = [w for v in groups.values() for r in v for w in [r['w']]]
with cf.ThreadPoolExecutor(8) as ex: list(ex.map(trades, ws))
toks = {}
for w in ws:
    for x in json.load(open(f'tr/{w}.json')): toks.setdefault(x['token_id'], x['condition_id'])
print('trades done; tokens', len(toks), flush=True)
os.makedirs('px', exist_ok=True)
def px(tok):
    f = f'px/{tok[:40]}.json'
    if os.path.exists(f): return
    d = get('prices-history', token_id=tok, start=CUT[2] - 3600, end=int(time.time()), bucket_seconds=300, limit=10000)
    json.dump(d and d['data'], open(f, 'w'))
with cf.ThreadPoolExecutor(8) as ex:
    for i, _ in enumerate(ex.map(px, list(toks))):
        if i % 500 == 0: print('px', i, time.strftime('%H:%M:%S'), flush=True)
conds = sorted(set(toks.values())); res = {}
for i in range(0, len(conds), 20):
    d = get('resolutions', condition=','.join(conds[i:i + 20]))
    for x in (d or {}).get('data', []) or []: res[x.get('condition_id') or x.get('condition')] = x
json.dump(res, open('res.json', 'w')); json.dump(toks, open('toks.json', 'w'))
print('done', len(res), flush=True)
