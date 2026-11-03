#!/usr/bin/env python3
"""Build live data for the Vespera Engine Vision concept.

Public endpoints only (no keys): Binance klines, Polymarket Gamma events and
CLOB prices-history/book. Writes data.js next to this script.
The market resolves on the Chainlink BTC/USD 60 s TWAP. Gamma publishes the start
price as eventMetadata.priceToBeat once a window has started; the model works in
Binance BTCUSDT units (K = Binance 60 s average before the start), so the
USDT basis between Binance and Chainlink cancels out.
"""
import concurrent.futures as cf
import json
import math
import os
import statistics
import time
import urllib.request

UA = {"User-Agent": "vespera-engine-viz/0.1"}
BINANCE = os.environ.get("VIZ_BINANCE", "https://data-api.binance.vision/api/v3/klines")  # public mirror
GAMMA = "https://gamma-api.polymarket.com/events?slug="
CLOB = "https://clob.polymarket.com"
N = int(os.environ.get("VIZ_WINDOWS", "96"))
FEE_RATE, SPREAD, MARGIN = 0.07, 0.01, 0.03
LAT = {}


def get(url, name=None, tries=3):
    for attempt in range(tries):
        try:
            t0 = time.perf_counter()
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                data = json.load(r)
            if name:
                LAT.setdefault(name, []).append((time.perf_counter() - t0) * 1000)
            return data
        except Exception:
            time.sleep(0.6 * (attempt + 1))
    return None


def klines(interval, start, end):
    out = []
    while start < end:
        rows = get(f"{BINANCE}?symbol=BTCUSDT&interval={interval}&startTime={start * 1000}&endTime={end * 1000}&limit=1000", "binance")
        if not rows:
            break
        out += [(r[0] // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in rows]
        start = rows[-1][0] // 1000 + 1
        if len(rows) < 1000:
            break
    return out


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def fair_value(s, k, sig, tau):
    """P(final 60 s TWAP >= start price) for a driftless log-price, sig per sqrt(second)."""
    if tau <= 0 or sig <= 0:
        return 1.0 if s >= k else 0.0
    eff = tau - 40 if tau > 60 else tau ** 3 / (3 * 3600)
    return phi(math.log(s / k) / (sig * math.sqrt(max(eff, 1e-6))))


def market(asset, ts):
    ev = get(f"{GAMMA}{asset}-updown-15m-{ts}", "gamma")
    if not ev:
        return None
    m = ev[0]["markets"][0]
    prices = [float(x) for x in json.loads(m.get("outcomePrices") or '["0.5","0.5"]')]
    ptb = (ev[0].get("eventMetadata") or {}).get("priceToBeat")
    return m, json.loads(m["clobTokenIds"]), prices, ptb


def quote(m, prices):
    """Best available UP mid for an open market: touch mid, then last trade, then outcome price."""
    bid, ask = m.get("bestBid"), m.get("bestAsk")
    if bid is not None and ask is not None and 0 < float(ask) - float(bid) < 0.5:
        return round((float(bid) + float(ask)) / 2, 4)
    if m.get("lastTradePrice") is not None:
        return float(m["lastTradePrice"])
    return prices[0]


def window(ts):
    got = market("btc", ts)
    if not got:
        return None
    m, toks, prices, ptb = got
    hist = get(f"{CLOB}/prices-history?market={toks[0]}&startTs={ts}&endTs={ts + 900}&fidelity=1", "clob")
    path = sorted((p["t"] - ts, float(p["p"])) for p in (hist or {}).get("history", []) if 0 <= p["t"] - ts <= 900)
    resolved = prices[0] >= 0.99 or prices[0] <= 0.01
    # K in Binance units: mean of the 1 s closes in the minute before the start, like the Chainlink TWAP.
    pre = get(f"{BINANCE}?symbol=BTCUSDT&interval=1s&startTime={(ts - 60) * 1000}&endTime={(ts - 1) * 1000}&limit=60", "binance") or []
    return {"ts": ts, "up": prices[0], "won": (prices[0] >= 0.5) if resolved else None,
            "vol": round(float(m.get("volume") or 0), 2), "path": [[t, round(p, 4)] for t, p in path],
            "token": toks[0], "tick": m.get("orderPriceMinTickSize"), "minSize": m.get("orderMinSize"),
            "ptb": round(ptb, 2) if ptb else None, "quote": quote(m, prices),
            "Kb": round(sum(float(r[4]) for r in pre) / len(pre), 2) if pre else None}


def pm_at(path, sec):
    best = None
    for t, p in path:
        if t <= sec:
            best = p
    return best


def main():
    now = int(time.time())
    cur = now - now % 900
    starts = [cur - 900 * k for k in range(N - 1, -1, -1)]
    with cf.ThreadPoolExecutor(8) as ex:
        wins = [w for w in ex.map(window, starts) if w]
    k1 = klines("1m", starts[0] - 3700, now)
    close_at = {r[0]: r[4] for r in k1}
    twap_at = {r[0] + 60: sum(r[1:]) / 4 for r in k1}  # OHLC/4 of the minute that ends at the key
    times = sorted(close_at)
    idx = {t: i for i, t in enumerate(times)}

    def sigma(at):
        i = idx.get(at - at % 60)
        if i is None or i < 61:
            return None
        cl = [close_at[times[j]] for j in range(i - 60, i)]
        r = [math.log(cl[j + 1] / cl[j]) for j in range(len(cl) - 1)]
        return statistics.pstdev(r) / math.sqrt(60)

    trades, edge_hours = [], {}
    for w in wins:
        ts = w["ts"]
        k = w.pop("Kb", None) or twap_at.get(ts)
        w["fv"], w["trade"] = [], None
        if not k:
            continue
        w["K"] = round(k, 2)
        if w["ptb"]:
            w["basis"] = round(k - w["ptb"], 2)
        for minute in range(1, 15):
            at = ts + 60 * minute
            if at > now - 60:
                break
            s, sg = close_at.get(at - 60), sigma(at)
            if not s or not sg:
                continue
            fv = fair_value(s, k, sg, 900 - 60 * minute)
            w["fv"].append([60 * minute, round(fv, 4)])
            pm = pm_at(w["path"], 60 * minute)
            if pm is None:
                continue
            if abs(fv - pm) > MARGIN:
                hour = (at // 3600) * 3600
                edge_hours[hour] = edge_hours.get(hour, 0) + 1
            if w["trade"] is None and 2 <= minute <= 12 and w["won"] is not None:
                for side, q, ask in (("up", fv, pm + SPREAD / 2), ("down", 1 - fv, 1 - pm + SPREAD / 2)):
                    if not 0.02 < ask < 0.98:
                        continue
                    fee_share = FEE_RATE * ask * (1 - ask)
                    if q - ask - fee_share > MARGIN:
                        shares = 1 / ask
                        fee = shares * fee_share
                        won = w["won"] == (side == "up")
                        pnl = (shares - 1 - fee) if won else (-1 - fee)
                        w["trade"] = {"side": side, "sec": 60 * minute, "price": round(ask, 3), "fv": round(fv, 3),
                                      "shares": round(shares, 2), "fee": round(fee, 4), "pnl": round(pnl, 4), "won": won}
                        trades.append(w["trade"])
                        break
    # Current window at 1 s resolution.
    k1s = get(f"{BINANCE}?symbol=BTCUSDT&interval=1s&startTime={min(now - 900, cur - 60) * 1000}&endTime={now * 1000}&limit=1000", "binance") or []
    pre = [float(r[4]) for r in k1s if r[0] // 1000 < cur]
    pre = pre[-60:]
    path1s = [[r[0] // 1000 - cur, float(r[4])] for r in k1s if r[0] // 1000 >= cur]
    spark = [[r[0] // 1000 - cur, float(r[4])] for r in k1s if r[0] // 1000 >= now - 900][::2]
    k_cur = round(sum(pre) / len(pre), 2) if pre else twap_at.get(cur)
    sg_cur = sigma(now - 60) or 0.00004
    s_now = path1s[-1][1] if path1s else close_at.get(times[-1])
    fv_path = [[t, round(fair_value(p, k_cur, sg_cur, 900 - t), 4)] for t, p in path1s[::5]]
    cw = next((w for w in wins if w["ts"] == cur), None)
    book = get(f"{CLOB}/book?token_id={cw['token']}", "clob") if cw else None
    bids = [[float(b["price"]), float(b["size"])] for b in (book or {}).get("bids", [])]
    asks = [[float(a["price"]), float(a["size"])] for a in (book or {}).get("asks", [])]
    best_bid = max((p for p, _ in bids), default=None)
    best_ask = min((p for p, _ in asks), default=None)
    pm_now = round((best_bid + best_ask) / 2, 4) if best_bid is not None and best_ask is not None else (cw or {}).get("quote")
    mk = []
    for asset in ("btc", "eth", "sol", "xrp"):
        got = market(asset, cur)
        if got:
            mid = get(f"{CLOB}/midpoint?token_id={got[1][0]}", "clob") or {}
            up = float(mid["mid"]) if mid.get("mid") else quote(got[0], got[2])
            mk.append({"asset": asset.upper(), "up": up, "vol": round(float(got[0].get("volume") or 0), 2)})
    # Clock heat: share of UP 15 m candles per UTC slot over 90 days.
    k15 = klines("15m", cur - 90 * 86400, cur)
    slots = [[0, 0] for _ in range(96)]
    for t, o, _, _, c in k15:
        s = (t % 86400) // 900
        slots[s][0] += c >= o
        slots[s][1] += 1
    clock = [round(a / b, 4) if b else 0.5 for a, b in slots]
    clock_n = round(statistics.median(b for _, b in slots)) if slots else 0
    basis = [w["basis"] for w in sorted(wins, key=lambda w: w["ts"]) if w.get("basis") is not None]
    hours = [(cur // 3600) * 3600 - 3600 * h for h in range(23, -1, -1)]
    n = len(trades)
    # Optional V1 reference: SMA signals priced at real Polymarket window-open prices.
    v1, v1_path = None, os.environ.get("VIZ_V1_ROUNDS")
    if v1_path and os.path.exists(v1_path):
        with open(v1_path, encoding="utf-8") as f:
            rounds = [r for r in json.load(f) if r.get("up_won") is not None]
        tot, won_n, entries = 0.0, 0, []
        for r in rounds:
            side_up = r["sig"] == 1
            ask = min(0.99, (r["up_open"] if side_up else 1 - r["up_open"]) + SPREAD)
            shares, won = 1 / ask, r["up_won"] == side_up
            fee = shares * FEE_RATE * ask * (1 - ask)
            tot += (shares - 1 - fee) if won else (-1 - fee)
            won_n += won
            entries.append(ask)
        if rounds:
            v1 = {"n": len(rounds), "wins": won_n, "net": round(tot, 2), "avgEntry": round(sum(entries) / len(entries), 3),
                  "days": round((rounds[-1]["ts"] - rounds[0]["ts"]) / 86400)}
    # Round-trip latency from the build host with small requests.
    LAT.clear()
    base = BINANCE.split("/api/")[0]
    for _ in range(3):
        get(f"{base}/api/v3/ping", "binance")
        get(f"{CLOB}/time", "clob")
        get(f"{GAMMA}btc-updown-15m-{cur}", "gamma")
    data = {
        "generatedAt": now, "windowSec": 900,
        "windows": [{k: v for k, v in w.items() if k != "token"} for w in wins],
        "current": {"ts": cur, "sec": now - cur, "S": s_now, "K": k_cur, "sigma": sg_cur,
                    "fv": fair_value(s_now, k_cur, sg_cur, 900 - (now - cur)) if s_now and k_cur else 0.5,
                    "pm": pm_now, "bid": best_bid, "ask": best_ask, "path1s": path1s, "fvPath": fv_path, "spark": spark},
        "book": {"bids": bids, "asks": asks,
                 "tick": (book or {}).get("tick_size"), "minSize": (book or {}).get("min_order_size")},
        "markets": mk,
        "latency": {k: round(statistics.median(v), 1) for k, v in LAT.items()},
        "clock": clock, "clockN": clock_n,
        "basis": {"recent": round(statistics.median(basis[-4:]), 2), "min": min(basis), "max": max(basis), "n": len(basis)} if basis else None,
        "edgeHourly": [edge_hours.get(h, 0) for h in hours],
        "pnl": {"n": n, "wins": sum(t["won"] for t in trades), "net": round(sum(t["pnl"] for t in trades), 4),
                "fees": round(sum(t["fee"] for t in trades), 4),
                "avgEntry": round(sum(t["price"] for t in trades) / n, 4) if n else None},
        "rules": {"feeRate": FEE_RATE, "spread": SPREAD, "margin": MARGIN},
        "v1": v1,
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("window.VESPERA_VIZ = " + json.dumps(data, separators=(",", ":")) + ";\n")
    print(f"windows {len(wins)}/{N}, trades {n}, net {data['pnl']['net']:+.2f}, current sec {now - cur}, "
          f"book {len(data['book']['bids'])}/{len(data['book']['asks'])}, size {os.path.getsize(out)} B")


if __name__ == "__main__":
    main()
