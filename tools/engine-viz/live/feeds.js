/* Vespera Engine Live — feeds. Public Polymarket sources only; runs in a browser (file:// or http) and in Node >= 22.
 *  RTDS  wss://ws-live-data.polymarket.com  activity/trades + Chainlink spot and 60 s TWAP for every symbol
 *        (unfiltered topics stream all symbols; a filtered subscribe returns ~1 min of history, used once at start)
 *  CLOB  wss://ws-subscriptions-clob.polymarket.com/ws/market  books, level changes, last trades, resolutions
 *  Gamma https://gamma-api.polymarket.com  tokens, fees, tick, min size, priceToBeat, official outcome
 * Each message becomes one normalized event with rt = Date.now() at receipt; see core.js for the schema. */
(function (global) {
  "use strict";
  const RTDS = "wss://ws-live-data.polymarket.com", CLOB = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const GAMMA = "https://gamma-api.polymarket.com";
  const ASSETS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"], TFS = [["15m", 900], ["5m", 300]];
  const sym = (s) => String(s || "").split("/")[0].toLowerCase();
  const J = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch (e) { return null; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // WebSocket with text PING keep-alive, capped exponential reconnect, and an idle watchdog: a socket that stays
  // open but goes silent for h.idle ms is dropped and replaced (a silent socket never fires onclose by itself).
  function socket(url, name, h, status) {
    let ws = null, timer = null, dog = null, wait = 1000, alive = true, last = 0;
    const send = (s) => { if (ws && ws.readyState === 1) ws.send(typeof s === "string" ? s : JSON.stringify(s)); };
    const retry = () => {
      clearInterval(timer); clearInterval(dog);
      if (!alive) return;
      status(name, "reconnect"); setTimeout(connect, wait); wait = Math.min(wait * 2, 20000);
      if (h.lost) h.lost();
    };
    const connect = () => {
      status(name, "connecting");
      try { ws = new WebSocket(url); } catch (e) { status(name, "error"); setTimeout(connect, wait); return; }
      const me = ws, drop = () => { me.onopen = me.onclose = me.onmessage = me.onerror = null; try { me.close(); } catch (e) {} ws = null; retry(); };
      const hung = setTimeout(() => { if (ws === me && me.readyState !== 1) { status(name, "timeout"); drop(); } }, 15000);
      ws.onopen = () => {
        clearTimeout(hung); wait = 1000; last = Date.now(); status(name, "open"); h.open(send); timer = setInterval(() => send("PING"), h.ping);
        if (h.idle) dog = setInterval(() => {
          if (ws !== me || Date.now() - last < h.idle) return;
          status(name, "silent"); drop();
        }, 1000);
      };
      ws.onmessage = (e) => { last = Date.now(); if (typeof e.data === "string" && e.data !== "PONG") h.message(e.data); };
      ws.onclose = () => { clearTimeout(hung); if (ws === me) retry(); };
      ws.onerror = () => {};
    };
    connect();
    return { send, close() { alive = false; clearInterval(timer); clearInterval(dog); try { ws && ws.close(); } catch (e) {} } };
  }

  class Feeds {
    constructor(emit, opts = {}) {
      this.out = emit; this.assets = opts.assets || ASSETS; this.watch = new Set(opts.watch || []);
      this.meta = new Map(); this.subs = new Set(); this.alive = true; this.clob = null;
    }
    emit(e) { e.rt = Date.now(); this.out(e); }
    status(name, st) { this.emit({ k: "feed", name, st }); }
    start() {
      const st = (n, s) => this.status(n, s);
      this.rtds = socket(RTDS, "rtds", {
        ping: 5000, idle: 15000, message: (s) => this.onRtds(s), lost: () => { this.gap = true; },
        open: (send) => {
          send({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" },
            { topic: "crypto_prices_chainlink", type: "*", filters: "" }, { topic: "crypto_prices_twap_sixty", type: "*", filters: "" }] });
          if (this.gap || !this.snapped) { this.gap = false; this.snapped = true; this.snapshot(); }
        },
      }, st);
      this.loop();
      return this;
    }
    stop() { this.alive = false; [this.rtds, this.clob, this.snap].forEach((s) => s && s.close()); }

    // History for K and σ: one filtered subscribe per symbol returns its recent points, then the socket closes.
    snapshot() {
      let got = 0;
      const want = this.assets.length * 2, s = this.snap = socket(RTDS, "snap", {
        ping: 5000,
        open: (send) => send({ action: "subscribe", subscriptions: this.assets.flatMap((a) => [
          { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: `${a}/usd` }) },
          { topic: "crypto_prices_twap_sixty", type: "*", filters: JSON.stringify({ symbol: `${a}/usd` }) }]) }),
        message: (raw) => {
          const d = J(raw), p = d && d.payload;
          if (!p || !Array.isArray(p.data) || !String(p.symbol || "").includes("/")) return;
          const k = d.topic === "crypto_prices_twap_sixty" ? "tw" : "cl";
          for (const x of p.data) if (x && x.timestamp && x.value != null) this.emit({ k, sym: sym(p.symbol), ts: +x.timestamp, v: +x.value, snap: 1 });
          if (++got >= want) { s.close(); this.status("snap", "done"); }
        },
      }, (n, v) => this.status(n, v));
      setTimeout(() => s.close(), 20000);
    }
    onRtds(raw) {
      const d = J(raw), p = d && d.payload;
      if (!p) return;
      if (d.topic === "activity") {
        const slug = p.slug || p.eventSlug || "";
        if (!/-updown-|-up-or-down-/.test(slug)) return;
        this.emit({ k: "trade", slug, ts: +p.timestamp, out: p.outcome, side: p.side, price: +p.price, size: +p.size,
          w: String(p.proxyWallet || "").toLowerCase(), name: p.name || p.pseudonym || "", fee: p.fee == null ? null : +p.fee });
      } else if ((d.topic === "crypto_prices_chainlink" || d.topic === "crypto_prices_twap_sixty") && p.symbol && p.value != null) {
        this.emit({ k: d.topic === "crypto_prices_twap_sixty" ? "tw" : "cl", sym: sym(p.symbol), ts: +p.timestamp, v: +p.value });
      }
    }
    onClob(raw) {
      const d = J(raw);
      if (!d) return;
      for (const x of Array.isArray(d) ? d : [d]) {
        const ts = +x.timestamp || null, lv = (a) => (a || []).map((l) => [+l.price, +l.size]);
        switch (x.event_type) {
          case "book": this.emit({ k: "book", tok: x.asset_id, ts, bids: lv(x.bids), asks: lv(x.asks) }); break;
          case "price_change": {
            const ch = (x.price_changes || []).map((c) => [c.asset_id, +c.price, +c.size, c.side === "BUY" ? "b" : "a"]);
            if (ch.length) this.emit({ k: "pc", ts, ch });
            break;
          }
          case "last_trade_price": this.emit({ k: "ltp", tok: x.asset_id, ts, p: +x.price, s: +x.size, side: x.side }); break;
          case "market_resolved": this.emit({ k: "res", cond: x.market, win: x.winning_asset_id, ts }); break;
          case "tick_size_change": this.emit({ k: "tick", tok: x.asset_id, tick: +x.new_tick_size }); break;
          default:
        }
      }
    }

    // Gamma every 15 s and right after each 5-minute boundary: new windows, then priceToBeat and outcome of ended ones.
    async loop() {
      while (this.alive) {
        try { await this.sync(); } catch (e) { this.status("gamma", "error"); }
        const now = Date.now() / 1000;
        await sleep(Math.min(15, 300 - (now % 300) + 1.5) * 1000);
      }
    }
    async sync() {
      const now = Math.floor(Date.now() / 1000), jobs = [];
      for (const a of this.assets) for (const [tf, d] of TFS) {
        const cur = now - (now % d);
        for (const st of [cur - d, cur, cur + d]) {
          const slug = `${a}-updown-${tf}-${st}`, m = this.meta.get(slug), ended = st + d <= now;
          if (!m || (ended && (m.win == null || m.ptb == null))) jobs.push(slug);
        }
      }
      for (const slug of this.watch) { const m = this.meta.get(slug); if (!m || m.win == null) jobs.push(slug); else this.watch.delete(slug); }
      // At most 4 requests in flight: a burst of ~40 parallel fetches makes Chromium fail some with ERR_INSUFFICIENT_RESOURCES.
      // A failed slug is simply retried on the next sync.
      const queue = jobs.slice(), worker = async () => { while (queue.length) await this.fetchMarket(queue.shift()).catch(() => null); };
      await Promise.all([worker(), worker(), worker(), worker()]);
      this.status("gamma", "open");
      // Books for live and next windows; keep ended windows until their resolution event, then drop them.
      const add = [], drop = [];
      for (const [slug, m] of this.meta) {
        if (!m.toks || !m.toks[0]) continue;
        const keep = m.end > now - (m.win == null ? 600 : 0) && m.start < now + 1000;
        m.toks.forEach((t, i) => {
          if (keep && !this.subs.has(t)) { this.subs.add(t); add.push(t); }
          if (!keep && this.subs.has(t)) { this.subs.delete(t); drop.push(t); }
        });
      }
      if (!this.clob && this.subs.size) {
        this.clob = socket(CLOB, "clob", { ping: 10000, idle: 30000, message: (s) => this.onClob(s),
          open: (send) => send({ assets_ids: [...this.subs], type: "market", custom_feature_enabled: true }) }, (n, s) => this.status(n, s));
      } else if (this.clob) {
        if (add.length) this.clob.send({ assets_ids: add, operation: "subscribe", custom_feature_enabled: true });
        if (drop.length) this.clob.send({ assets_ids: drop, operation: "unsubscribe" });
      }
      for (const [slug, m] of this.meta) if (m.end < now - 7200 && !this.watch.has(slug)) this.meta.delete(slug);
    }
    async fetchMarket(slug) {
      const r = await fetch(`${GAMMA}/events?slug=${slug}`);
      if (!r.ok) throw new Error(`gamma ${r.status}`);
      const ev = (await r.json())[0], mk = ev && ev.markets && ev.markets[0];
      if (!mk) return;
      const toks = J(mk.clobTokenIds) || [], outs = J(mk.outcomes) || [], prices = (J(mk.outcomePrices) || []).map(Number);
      const iu = Math.max(0, outs.indexOf("Up")), meta = ev.eventMetadata || mk.eventMetadata || {};
      const fs = mk.feeSchedule || {}, cfg = mk.cryptoMarketConfig || ev.cryptoMarketConfig || {};
      const settled = mk.closed && prices.length === 2 && prices[0] + prices[1] === 1 && (prices[iu] === 1 || prices[iu] === 0);
      const st = +slug.split("-").pop(), d = slug.includes("-15m-") ? 900 : 300;
      const e = { k: "mkt", slug, start: st, end: st + d, cond: mk.conditionId, toks: [toks[iu], toks[1 - iu]], fee: fs.rate == null ? null : +fs.rate,
        fexp: fs.exponent == null ? null : +fs.exponent, tick: +mk.orderPriceMinTickSize || null, min: +mk.orderMinSize || null,
        twap: cfg.twapEnabled == null ? null : !!cfg.twapEnabled, ptb: meta.priceToBeat == null ? null : +meta.priceToBeat,
        fin: meta.finalPrice == null ? null : +meta.finalPrice, win: settled ? (prices[iu] === 1 ? 0 : 1) : null };
      const old = this.meta.get(slug);
      this.meta.set(slug, e);
      if (!old || old.ptb !== e.ptb || old.win !== e.win || old.fin !== e.fin) this.emit(Object.assign({}, e));
    }
  }

  const api = { Feeds, ASSETS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.VesperaFeeds = api;
})(typeof window !== "undefined" ? window : globalThis);
