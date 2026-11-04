/* Vespera Engine Live — feeds. Public Polymarket sources only; runs in a browser (file:// or http) and in Node >= 22.
 *  RTDS  wss://ws-live-data.polymarket.com  activity/trades (every fill on every market) + Chainlink spot and 60 s TWAP
 *        (unfiltered topics stream all symbols; a filtered subscribe returns ~1 min of history, used once at start)
 *  CLOB  wss://ws-subscriptions-clob.polymarket.com/ws/market  books, level changes, last trades, resolutions
 *  Gamma https://gamma-api.polymarket.com  the catalog of open events (keyset pages, busiest first), event details
 *        (markets, prices, tokens) on request; for crypto Up/Down: tokens, fees, tick, min size, priceToBeat, outcome
 * Each message becomes one normalized event with rt = Date.now() at receipt; see core.js for the schema. */
(function (global) {
  "use strict";
  const RTDS = "wss://ws-live-data.polymarket.com", CLOB = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const GAMMA = "https://gamma-api.polymarket.com", CLOBR = "https://clob.polymarket.com";
  const ASSETS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"], TFS = [["15m", 900], ["5m", 300]];
  const sym = (s) => String(s || "").split("/")[0].toLowerCase();
  const J = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch (e) { return null; } };
  const lv = (a) => (a || []).map((l) => [+l.price, +l.size]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sec = (iso) => { const t = Date.parse(iso || ""); return isFinite(t) ? Math.round(t / 1000) : null; };
  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
  // one catalog row: id, slug, title, 24 h volume, end (s), market count, tags (lower case, "|"-joined)
  const row = (e) => ({ id: String(e.id), s: e.slug || "", t: e.title || "", v: +e.volume24hr || 0, e: sec(e.endDate), n: +e.cumulativeMarkets || null,
    g: (e.tags || []).map((x) => String(x.label || "").toLowerCase()).filter(Boolean).join("|") });
  const mrow = (m) => {
    const o = J(m.outcomes) || [], p = (J(m.outcomePrices) || []).map(Number), tk = J(m.clobTokenIds) || [];
    return { c: m.conditionId, q: m.groupItemTitle || m.question || "", o: [o[0] || "Yes", o[1] || "No"], p: [isFinite(p[0]) ? p[0] : null, isFinite(p[1]) ? p[1] : null],
      bb: m.bestBid == null ? null : +m.bestBid, ba: m.bestAsk == null ? null : +m.bestAsk, l: m.lastTradePrice == null ? null : +m.lastTradePrice,
      tk: [tk[0] || null, tk[1] || null], v: +m.volume || 0, x: !!m.closed || m.active === false };   // inactive: placeholders the site hides
  };

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
      this.catalog = opts.catalog !== false; this.cache = opts.cache || null; this.asked = new Set(); this.dq = []; this.lq = []; this.dBusy = 0; this.gsubs = new Set(); this.wsBook = new Set();
      this.rAsked = new Set(); this.rq = []; this.rBusy = false;
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
      if (this.catalog) this.crawl();
      return this;
    }
    stop() { this.alive = false; [this.rtds, this.clob, this.snap].forEach((s) => s && s.close()); }

    // The catalog: every open event, 100 a page, busiest (24 h volume) first, so the ring fills with what matters first.
    // About 210 pages for ~21k events; keyset pages have no depth limit (offset paging stops at ~2500). With a cache
    // (the page keeps the last full catalog in IndexedDB) the whole ring is there at once and the crawl refreshes it.
    async crawl() {
      let cur = "", n = 0, wait = 1000;
      const fresh = this.cache ? [] : null;
      if (this.cache) {
        try {
          const c = await this.cache.load();
          if (c && c.rows && c.rows.length && Date.now() - c.at < 48 * 3600e3) this.emit({ k: "cat", n: -1, rows: c.rows, cached: true, at: c.at, done: false });
        } catch (e) {}
      }
      while (this.alive) {
        try {
          const d = await getJSON(`${GAMMA}/events/keyset?closed=false&include_markets=false&order=volume24hr&ascending=false&limit=100${cur ? `&after_cursor=${encodeURIComponent(cur)}` : ""}`);
          const rows = (d.events || []).map(row);
          cur = d.next_cursor || "";
          if (fresh) for (const r of rows) fresh.push(r);
          this.emit({ k: "cat", n: n++, rows, done: !cur || !rows.length });
          this.status("catalog", cur && rows.length ? "loading" : "done"); wait = 1000;
          if (!cur || !rows.length) { if (fresh && fresh.length > 1000) Promise.resolve().then(() => this.cache.save(fresh)).catch(() => {}); return; }
        } catch (e) { this.status("catalog", "error"); await sleep(wait); wait = Math.min(wait * 2, 30000); }
      }
    }
    // Event details (markets, prices, tokens) for events the screen shows or that just traded. items: {id} or {slug}.
    // Card projection: no descriptions; at most 30 events a request, 2 requests in flight. What the screen asks for goes
    // newest first (after a fast spin the events in view come before those it passed; the oldest 150 are dropped and
    // can be asked again); low = background (the busiest events, so they are ready before the ring gets there).
    details(items, low) {
      for (const it of items) {
        const key = it.id ? `id=${encodeURIComponent(it.id)}` : it.slug ? `slug=${encodeURIComponent(it.slug)}` : null;
        if (!key) continue;
        if (this.asked.has(key)) { const i = low ? -1 : this.lq.indexOf(key); if (i >= 0) { this.lq.splice(i, 1); this.dq.push(key); } continue; }
        this.asked.add(key); (low ? this.lq : this.dq).push(key);
      }
      if (this.dq.length > 150) for (const k of this.dq.splice(0, this.dq.length - 150)) this.asked.delete(k);
      while (this.dBusy < 2 && (this.dq.length || this.lq.length)) this.detailBatch();
    }
    async detailBatch() {
      const keys = this.dq.length ? this.dq.splice(-30) : this.lq.splice(0, 30);
      this.dBusy++;
      try {
        const evs = await getJSON(`${GAMMA}/events?${keys.join("&")}&market_projection=card&limit=${keys.length}`);   // Gamma returns 20 unless told
        for (const e of evs || []) this.emit(Object.assign({ k: "evd", mk: (e.markets || []).map(mrow) }, row(e)));
        this.status("details", "open");
      } catch (err) { keys.forEach((k) => this.asked.delete(k)); this.status("details", "error"); await sleep(3000); }
      this.dBusy--;
      if ((this.dq.length || this.lq.length) && this.alive) this.detailBatch();
    }
    // Some RTDS fills carry the token only: token → its event (Gamma markets), then that event's details as usual
    resolve(toks) {
      for (const t of toks || []) if (t && !this.rAsked.has(t)) { this.rAsked.add(t); this.rq.push(t); }
      if (!this.rBusy && this.rq.length) this.resolveBatch();
    }
    async resolveBatch() {
      const toks = this.rq.splice(0, 20);
      this.rBusy = true;
      try {
        const ms = await getJSON(`${GAMMA}/markets?${toks.map((t) => `clob_token_ids=${t}`).join("&")}&limit=${toks.length}`), slugs = new Set();
        for (const m of ms || []) for (const e of m.events || []) if (e.slug) slugs.add(e.slug);
        if (slugs.size) this.details([...slugs].map((slug) => ({ slug })));
      } catch (err) { toks.forEach((t) => this.rAsked.delete(t)); await sleep(3000); }
      this.rBusy = false;
      if (this.rq.length && this.alive) this.resolveBatch();
    }
    // Books for tokens outside the crypto engine (the market in focus): the set replaces the previous one.
    books(toks) {   // returns the tokens no longer watched (their books stop updating)
      const want = new Set((toks || []).filter(Boolean)), add = [], drop = [];
      for (const t of want) if (!this.gsubs.has(t)) { this.gsubs.add(t); if (!this.subs.has(t)) add.push(t); }
      for (const t of [...this.gsubs]) if (!want.has(t)) { this.gsubs.delete(t); this.wsBook.delete(t); if (!this.subs.has(t)) drop.push(t); }
      this.clobSync(add, drop);
      if (add.length) this.restBooks(add);
      return drop;
    }
    // the socket's snapshot of a new subscription can come late (at times seconds late): the REST books of the new
    // tokens (one request, ~0.1 s) stand in until it does; a snapshot the socket already sent is not replaced
    async restBooks(toks) {
      for (let i = 0; i < toks.length; i += 20) {
        try {
          const r = await fetch(`${CLOBR}/books`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toks.slice(i, i + 20).map((t) => ({ token_id: t }))) });
          if (!r.ok) continue;
          for (const x of (await r.json()) || []) {
            const t = x && x.asset_id;
            if (t && this.gsubs.has(t) && !this.wsBook.has(t)) this.emit({ k: "book", tok: t, ts: +x.timestamp || null, bids: lv(x.bids), asks: lv(x.asks) });
          }
        } catch (e) {}
      }
    }
    clobSync(add, drop) {
      const all = new Set([...this.subs, ...this.gsubs]);
      if (!this.clob && all.size) {
        this.clob = socket(CLOB, "clob", { ping: 10000, idle: 30000, message: (s) => this.onClob(s),
          open: (send) => send({ assets_ids: [...this.subs, ...this.gsubs].filter((t, i, a) => a.indexOf(t) === i), type: "market", custom_feature_enabled: true }) },
          (n, s) => this.status(n, s));
      } else if (this.clob) {
        if (add.length) this.clob.send({ assets_ids: add, operation: "subscribe", custom_feature_enabled: true });
        if (drop.length) this.clob.send({ assets_ids: drop, operation: "unsubscribe" });
      }
    }

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
        // every fill on every market; ev = event slug (the ring slot), cond/tok = market and outcome token
        const slug = p.slug || p.eventSlug || "";
        this.emit({ k: "trade", slug, ev: p.eventSlug || "", cond: p.conditionId || "", tok: p.asset || "", oi: p.outcomeIndex == null ? null : +p.outcomeIndex,
          q: p.title || "", ts: +p.timestamp, out: p.outcome, side: p.side, price: +p.price, size: +p.size,
          w: String(p.proxyWallet || "").toLowerCase(), name: p.name || p.pseudonym || "", fee: p.fee == null ? null : +p.fee });
      } else if ((d.topic === "crypto_prices_chainlink" || d.topic === "crypto_prices_twap_sixty") && p.symbol && p.value != null) {
        this.emit({ k: d.topic === "crypto_prices_twap_sixty" ? "tw" : "cl", sym: sym(p.symbol), ts: +p.timestamp, v: +p.value });
      }
    }
    onClob(raw) {
      const d = J(raw);
      if (!d) return;
      for (const x of Array.isArray(d) ? d : [d]) {
        const ts = +x.timestamp || null;
        switch (x.event_type) {
          case "book": if (this.gsubs.has(x.asset_id)) this.wsBook.add(x.asset_id); this.emit({ k: "book", tok: x.asset_id, ts, bids: lv(x.bids), asks: lv(x.asks) }); break;
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
      this.clobSync(add, drop.filter((t) => !this.gsubs.has(t)));
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

  const api = { Feeds, ASSETS, row: (e) => row(e), mrow: (m) => mrow(m) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.VesperaFeeds = api;
})(typeof window !== "undefined" ? window : globalThis);
