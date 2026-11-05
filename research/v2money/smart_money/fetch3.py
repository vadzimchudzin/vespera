"""Price paths for stage 2 (fetch2's 5-min paths came back empty: the Data API caps limit at 1000). CLOB prices-history,
fidelity 5 min, per token over [first BUY - 10 min, last BUY + 1 day + 10 min] in <= 14-day chunks; resolved markets only."""
import json, os, time, urllib.request, concurrent.futures as cf
G = json.load(open('groups.json')); RES = json.load(open('res.json'))
span = {}
for g, ws in G.items():
    for w in ws:
        try: tr = json.load(open(f'tr/{w}.json'))
        except Exception: continue
        for x in tr:
            if x['side'] != 'BUY': continue
            r = RES.get(x['condition_id'])
            if not (r and r.get('status') == 'resolved'): continue
            t = int(x['timestamp']); a = span.get(x['token_id'])
            span[x['token_id']] = (min(a[0], t), max(a[1], t)) if a else (t, t)
os.makedirs('px3', exist_ok=True)
NOW = int(time.time())
def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'vespera-research'}), timeout=30) as r: return json.load(r)
        except Exception as e:
            if getattr(e, 'code', None) in (400, 404): return None
            time.sleep(1.5 * (i + 1))
    return None
def fetch(tok):
    f = f'px3/{tok[:40]}.json'
    if os.path.exists(f): return
    a, b = span[tok]; a -= 600; b = min(NOW, b + 86400 + 600)
    out = []
    while a < b:
        e = min(b, a + 14 * 86400)
        d = get(f'https://clob.polymarket.com/prices-history?market={tok}&startTs={a}&endTs={e}&fidelity=5')
        out += (d or {}).get('history', []) or []
        a = e
    json.dump(out, open(f, 'w'))
toks = list(span)
print('tokens', len(toks), flush=True)
with cf.ThreadPoolExecutor(12) as ex:
    for i, _ in enumerate(ex.map(fetch, toks)):
        if i % 1000 == 0: print('px3', i, time.strftime('%H:%M:%S'), flush=True)
print('done', flush=True)
