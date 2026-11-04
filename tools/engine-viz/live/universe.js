/* Vespera Engine Live — universe: every open Polymarket event as one slot on the ring. No DOM, no network.
 * Fed by Gamma catalog pages ("cat", ~21k open events, busiest first), event details ("evd": markets, prices, tokens),
 * every trade, and CLOB books for tokens outside the crypto engine. The renderer reads the slots and their order.
 *  - crypto Up/Down windows are collapsed: the 7 engine assets × 5m/15m keep the engine slots (BTC: previous, live and
 *    next window); every other series (ZEC 5m, gold 15m, BTC 4h, hourly, daily, stocks, FX) is one slot for all windows;
 *  - sectors follow the event's Gamma tags; an event seen in a trade before the catalog has it waits in "other"
 *    until its details arrive, then moves to its sector's end;
 *  - a slot's length on the ring (weight) follows its 24 h volume, so events nobody trades take little room;
 *    a slot that trades during the session is promoted. */
(function (global) {
  "use strict";
  const SECTORS = [
    ["crypto", "КРИПТО", "125,150,255"], ["politics", "ПОЛИТИКА", "190,140,255"], ["geo", "ГЕОПОЛИТИКА", "255,135,165"],
    ["finance", "ФИНАНСЫ", "150,215,120"], ["tech", "ТЕХ · AI", "110,200,235"], ["culture", "КУЛЬТУРА", "240,185,105"],
    ["weather", "ПОГОДА", "150,190,215"], ["esports", "КИБЕРСПОРТ", "215,120,235"], ["sports", "СПОРТ", "205,200,115"], ["other", "ПРОЧЕЕ", "165,165,165"],
  ].map(([id, label, col], i) => ({ id, label, col, i }));
  const SIDX = Object.fromEntries(SECTORS.map((s) => [s.id, s.i]));
  const TAGS = {
    crypto: "crypto|crypto prices|bitcoin|ethereum|solana|xrp|dogecoin|bnb|hype|zcash|memecoins|stablecoins|airdrops|token launch|fdv|pre-market",
    esports: "esports|counter strike 2|league of legends|dota 2|valorant|call of duty|rainbow six|overwatch|cs2|lol",
    sports: "sports|soccer|basketball|tennis|football|hockey|baseball|cricket|golf|mma|ufc|boxing|f1|formula 1|nfl|nba|nhl|mlb|table tennis|games|chess|pickleball|ncaa|wnba",
    politics: "politics|elections|us election|midterms|global elections|world elections|trump|congress|senate|house elections|2028 election|us politics|poltics",
    geo: "geopolitics|world|iran|ukraine|russia|israel|middle east|china|gaza|venezuela|foreign policy",
    finance: "finance|economy|equities|earnings|stocks|commodities|fed|fed rates|business|economic policy|ipos|ipo|forex|inflation|up or down|indices",
    tech: "tech|ai|science|space|openai|elon musk|spacex|big tech",
    culture: "culture|pop culture|movies|music|celebrities|mentions|awards|tweets markets|twitter|youtube|tv|box office|gaming|religion",
    weather: "weather|climate|daily temperature|climate & science|hurricanes|temperature",
  };
  const TAGSET = Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [k, new Set(v.split("|"))]));
  const ORDER = ["crypto", "esports", "sports", "politics", "geo", "finance", "tech", "culture", "weather"];   // first match wins
  const ENG = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"], CRYPTO = new Set([...ENG, "zec", "bitcoin", "ethereum", "solana", "dogecoin", "hyperliquid"]);
  const NAME = { bitcoin: "btc", ethereum: "eth", solana: "sol", dogecoin: "doge", hyperliquid: "hype" };
  const U = 20;   // unit slot length on the ring, px at zoom 1

  // Up/Down series of a slug: {key, a, tf} or null. 5m/15m windows of the engine assets map to engine slots.
  function series(slug) {
    let m = /^([a-z0-9]+)-updown-(\d+[mh])-(\d{9,})$/.exec(slug || "");
    if (m) return { a: m[1], tf: m[2], start: +m[3] };
    m = /^([a-z0-9]+)-up-or-down-(?!on-).*-\d{1,2}(am|pm)-et$/.exec(slug || "");
    if (m) return { a: NAME[m[1]] || m[1], tf: "1h" };
    m = /^([a-z0-9]+)-(opens-)?up-or-down-on-/.exec(slug || "");
    if (m) return { a: NAME[m[1]] || m[1], tf: m[2] ? "open" : "1d" };
    return null;
  }
  const engKey = (a, tf, rel) => `eng:${a}:${tf}:${rel}`;
  function classify(tags, slug) {
    const t = new Set(String(tags || "").split("|").filter(Boolean));
    for (const id of ORDER) for (const x of t) if (TAGSET[id].has(x)) return id;
    if (/-(vs|win|beat)-|nba|nfl|nhl|mlb|epl|ucl|atp|wta|ufc/.test(slug || "")) return "sports";
    return t.size ? "other" : null;
  }
  const subTag = (tags) => { const t = String(tags || "").split("|").filter((x) => x && !/^(sports|games|recurring|hide from new|politics|crypto|crypto prices|up or down|5m|15m|1h|featured|parent for derivative|earn .*|rewards .*)$/.test(x)); return t[0] || ""; };

  class Universe {
    constructor() {
      this.slots = new Map();   // key → slot; key = "ev:<event slug>", "ser:<asset>:<tf>", "eng:<asset>:<tf>:<rel>"
      this.byId = new Map(); this.sec = SECTORS.map((s) => ({ ...s, eng: [], ser: [], ev: [], n: 0, c0: 0, c1: 0, hits: new Float64Array(60), hitAt: 0 }));
      this.ring = []; this.len = 0; this.v = 0; this.dirty = true; this.relAt = -1e9; this.promo = [];
      this.cat = { rows: 0, pages: 0, done: false }; this.needs = []; this.books = new Map(); this.focusToks = [];
      this.tokEv = new Map(); this.orphans = []; this.tokNeeds = [];   // token → {slot, market, outcome}; fills waiting for theirs
      for (const a of ["eth", "sol", "xrp"]) for (const tf of ["15m", "5m"]) this.eng(a, tf, 0, 1.3);
      for (const tf of ["15m", "5m"]) for (const rel of [-1, 0, 1]) this.eng("btc", tf, rel, rel ? 1.1 : 3.2);
      for (const a of ["doge", "hype", "bnb"]) for (const tf of ["15m", "5m"]) this.eng(a, tf, 0, 1.3);
    }
    eng(a, tf, rel, w) {
      const s = this.slot(engKey(a, tf, rel), "eng", "crypto", { a, tf, rel, w, title: `${a.toUpperCase()} Up or Down ${tf}` });
      s.focus = a === "btc" && !rel;
      return s;
    }
    slot(key, kind, sec, init) {
      let s = this.slots.get(key);
      if (s) return s;
      s = Object.assign({ key, kind, sec: SIDX[sec], title: "", slug: "", id: null, v24: 0, end: null, nm: null, tags: "", sub: "", w: 0.25,
        c: 0, h: U, i: 0, n: 0, usd: 0, last: null, mk: new Map(), det: 0, guess: false, seen: 0 }, init || {});
      s.h = s.w * U;
      this.slots.set(key, s); this.sec[s.sec][kind].push(s); this.dirty = true;
      return s;
    }
    move(s, sec) {
      const to = SIDX[sec];
      if (to == null || to === s.sec) return;
      const a = this.sec[s.sec][s.kind], i = a.indexOf(s);
      if (i >= 0) a.splice(i, 1);
      s.sec = to; this.sec[to][s.kind].push(s); this.dirty = true;
    }
    weight(s) { return s.kind !== "ev" ? s.w : s.n > 0 || s.v24 >= 100 ? 1 : s.v24 > 0 ? 0.5 : 0.15; }

    // ---- catalog and details ------------------------------------------------------------------
    onCatalog(e) {
      this.cat.pages++; this.cat.rows += e.rows.length; if (e.done) this.cat.done = true;
      for (const r of e.rows) this.row(r);
    }
    row(r) {
      const ser = series(r.s);
      if (ser) {
        if (ENG.includes(ser.a) && (ser.tf === "5m" || ser.tf === "15m")) return null;   // the engine's own windows
        const key = `ser:${ser.a}:${ser.tf}`, nm = r.t.replace(/\s*-\s*[A-Z][a-z]+ \d+.*$/, "").replace(/ on [A-Z][a-z]+ \d+\??$/, "").replace(/\?$/, "");
        const s = this.slot(key, "ser", CRYPTO.has(ser.a) ? "crypto" : "finance", { a: ser.a, tf: ser.tf, w: 1, title: `${nm} · ${ser.tf}` });
        // every open window of the series: its end (for the thread's time to its end) and its 24 h volume
        (s.ends || (s.ends = new Map())).set(r.s, r.e); (s.vols || (s.vols = new Map())).set(r.s, r.v || 0);
        let v = 0; for (const x of s.vols.values()) v += x;
        s.v24 = v;
        return s;
      }
      const key = `ev:${r.s}`;
      let s = this.slots.get(key);
      const sec = classify(r.g, r.s) || "other";
      if (!s) s = this.slot(key, "ev", sec, {});
      else if (s.guess || s.sec !== SIDX[sec]) this.move(s, sec);
      Object.assign(s, { slug: r.s, id: r.id, title: r.t || s.title, v24: r.v || 0, end: r.e, nm: r.n, tags: r.g, sub: subTag(r.g), guess: false });
      this.byId.set(r.id, s);
      const w = this.weight(s); if (w !== s.w) { s.w = w; this.dirty = true; }
      return s;
    }
    onDetails(e) {
      const s = this.row(e);
      if (!s || s.kind !== "ev") return;
      s.det = 2;
      for (const x of e.mk) {
        const m = this.market(s, x.c, x.q);
        Object.assign(m, { q: x.q || m.q, o: x.o, tk: x.tk, v: x.v, x: x.x, bb: x.bb, ba: x.ba });
        if (m.p0 == null || !m.n) m.p0 = x.p[0] != null ? x.p[0] : x.l;
        if (x.tk[0]) this.books.has(x.tk[0]) && (this.books.get(x.tk[0]).m = m);
        x.tk.forEach((t, i) => { if (t) this.tokEv.set(t, { s, m, i }); });
      }
      s.lead = null;
      if (this.orphans.length) this.rehome();
    }
    market(s, cond, q) {
      let m = s.mk.get(cond);
      if (!m) { m = { c: cond, q: q || "", o: ["Yes", "No"], tk: [null, null], v: 0, x: false, bb: null, ba: null, p0: null, n: 0, usd: 0, last: null }; s.mk.set(cond, m); s.lead = null; }
      return m;
    }
    // markets of an event, leading first: the most traded (session $, then lifetime volume) open ones
    leads(s) {
      if (s.lead && s.leadN === s.n) return s.lead;
      s.lead = [...s.mk.values()].filter((m) => !m.x).sort((a, b) => b.usd - a.usd || b.v - a.v); s.leadN = s.n;
      return s.lead;
    }
    want(s) { if (s.kind === "ev" && !s.det && (s.id || s.slug)) { s.det = 1; this.needs.push(s.id ? { id: s.id } : { slug: s.slug }); } }
    takeNeeds() { const n = this.needs; this.needs = []; return n; }
    takeToks() { const t = [...new Set(this.tokNeeds)]; this.tokNeeds = []; return t; }

    // ---- trades -------------------------------------------------------------------------------
    // T from Engine.onTrade; returns its slot (engine slots are resolved by the renderer for BTC's previous/next window)
    // RTDS sends some fills with the token only (no slug, no title, outcome index 0): they take their market from the
    // token once an event's details list it; until then they wait (the feed looks the token up) and are not drawn.
    onTrade(T) {
      let s;
      const ser = series(T.ev || T.slug);
      if (!T.ev && !T.slug) {
        const r = T.tok ? this.tokEv.get(T.tok) : null;
        if (!r) { if (T.tok) { if (this.orphans.length < 20000) this.orphans.push(T); this.tokNeeds.push(T.tok); } return null; }
        this.fill(T, r); s = r.s;
      } else if (ser && ENG.includes(ser.a) && (ser.tf === "5m" || ser.tf === "15m")) s = this.slots.get(engKey(ser.a, ser.tf, 0));
      else if (ser) s = this.slots.get(`ser:${ser.a}:${ser.tf}`) || this.slot(`ser:${ser.a}:${ser.tf}`, "ser", CRYPTO.has(ser.a) ? "crypto" : "finance", { a: ser.a, tf: ser.tf, w: 1, title: `${ser.a.toUpperCase()} Up or Down · ${ser.tf}` });
      else {
        const key = `ev:${T.ev || T.slug}`;
        s = this.slots.get(key);
        if (!s) { s = this.slot(key, "ev", "other", { slug: T.ev || T.slug, title: T.q, guess: true, w: 1 }); this.want(s); }
      }
      this.hit(s, T);
      return s;
    }
    hit(s, T) {
      if (!s.n && s.kind === "ev" && s.w < 1) this.promo.push(s);
      s.n++; s.usd += T.usd;
      if (!s.last || T.rt >= s.last.rt) { s.last = T; s.seen = T.rt; }
      if (s.kind === "ev") {
        this.want(s);
        const m = this.market(s, T.cond, T.q);
        m.n++; m.usd += T.usd;
        if (!m.last || T.rt >= m.last.rt) { m.last = T; m.p0 = T.p; }
        if (T.oi != null && T.out) m.o[T.oi] = T.out;
        if (T.tok && T.oi != null && !m.tk[T.oi]) m.tk[T.oi] = T.tok;
      }
      const S = this.sec[s.sec], sc = Math.floor(T.rt / 1000);
      if (sc - S.hitAt >= 60) { S.hits.fill(0); S.hitAt = sc; }
      while (S.hitAt < sc) { S.hitAt++; S.hits[S.hitAt % 60] = 0; }
      if (S.hitAt - sc < 60) S.hits[sc % 60]++;
    }
    fill(T, r) {   // market, outcome and price side of a fill from its token
      const m = r.m;
      T.ev = r.s.slug; T.cond = m.c; T.q = m.q || r.s.title; T.out = m.o[r.i] || T.out;
      if (T.oi !== r.i) { T.oi = r.i; T.p = r.i === 0 ? T.price : 1 - T.price; T.up = (r.i === 0) === (T.side === "BUY"); }
    }
    rehome() {
      const left = [];
      for (const T of this.orphans) {
        const r = this.tokEv.get(T.tok);
        if (!r) { left.push(T); continue; }
        this.fill(T, r); T.s = r.s; T._k = null; this.hit(r.s, T);   // _k: the renderer's cached geometry is stale
      }
      this.orphans = left;
    }
    rate(S, now, w = 10) { const sc = Math.floor(now / 1000); let a = 0; for (let k = 1; k <= w; k++) { const q = sc - k; if (q <= S.hitAt && S.hitAt - q < 60) a += S.hits[q % 60]; } return a / w; }

    // ---- books outside the engine (outcome-0 token of the market in focus) ----------------------
    book(tok) { return this.books.get(tok) || null; }
    newBook(tok) { const b = { bids: new Map(), asks: new Map(), lvl: new Map(), bookN: 0, bookRt: 0, bb: null, ba: null, mid: null }; this.books.set(tok, b); return b; }
    watch(toks) { this.focusToks = toks; for (const t of toks) if (t && !this.books.has(t)) this.newBook(t); }
    onBook(e) {   // a snapshot opens a book even for a token not asked for: a replay carries the books it recorded
      if (!e.tok) return false;
      const b = this.books.get(e.tok) || this.newBook(e.tok);
      const old = [b.bids, b.asks], k = (l) => l.map(([p, s]) => [Math.round(p * 1e4), s]);
      b.bids = new Map(k(e.bids)); b.asks = new Map(k(e.asks));
      [["b", b.bids, old[0]], ["a", b.asks, old[1]]].forEach(([side, cur, prev]) => {
        for (const [q, s] of cur) if (prev.get(q) !== s) b.lvl.set(side + q, e.rt);
        for (const q of prev.keys()) if (!cur.has(q)) b.lvl.set(side + q, e.rt);
      });
      b.bookN++; b.bookRt = e.rt; this.best(b);
      return true;
    }
    onLevel(tok, p, s, side, rt) {
      const b = this.books.get(tok);
      if (!b) return false;
      const book = side === "b" ? b.bids : b.asks, q = Math.round(p * 1e4);
      if (s > 0) { if (book.get(q) === s) return true; book.set(q, s); } else if (!book.delete(q)) return true;
      b.lvl.set(side + q, rt); b.bookN++; b.bookRt = rt; this.best(b);
      return true;
    }
    best(b) {
      let bb = -1, ba = Infinity;
      for (const q of b.bids.keys()) if (q > bb) bb = q;
      for (const q of b.asks.keys()) if (q < ba) ba = q;
      b.bb = bb < 0 ? null : bb / 1e4; b.ba = ba === Infinity ? null : ba / 1e4; b.mid = b.bb != null && b.ba != null ? (b.bb + b.ba) / 2 : null;
      if (b.m) { b.m.bb = b.bb; b.m.ba = b.ba; }
    }
    levels(b) {
      if (b._lv && b._lvN === b.bookN) return b._lv;
      const conv = (map, dir) => [...map].map(([q, s]) => [q / 1e4, s]).sort((x, y) => dir * (x[0] - y[0]));
      b._lv = { bids: conv(b.bids, -1), asks: conv(b.asks, 1) }; b._lvN = b.bookN;
      return b._lv;
    }
    prune(now) { for (const b of this.books.values()) for (const [q, t] of b.lvl) if (t < now - 15000) b.lvl.delete(q); }

    // ---- ring order ---------------------------------------------------------------------------
    // Sectors in ring order; in each: engine slots, then series and events by 24 h volume (+ this session's), as the site
    // sorts them. The order is redone only when the ring changes (new slots, catalog pages, promotions); promotions (an
    // idle slot that traded) are applied at most every 5 s, so the ring does not twitch with every fill.
    layout(now) {
      if (this.promo.length && now - this.relAt > 5000) { for (const s of this.promo) { const w = this.weight(s); if (w !== s.w) { s.w = w; this.dirty = true; } } this.promo = []; }
      if (!this.dirty) return false;
      let c = 0, i = 0;
      this.ring = [];
      for (const S of this.sec) {
        S.c0 = c; S.n = S.eng.length + S.ser.length + S.ev.length; S.i0 = i;
        const vol = (a, b) => b.v24 + b.usd - (a.v24 + a.usd);
        S.ser.sort(vol); S.ev.sort(vol);
        for (const list of [S.eng, S.ser, S.ev]) for (const s of list) { s.h = s.w * U; s.c = c; s.i = i++; c += s.h; this.ring.push(s); }
        S.c1 = c;
      }
      this.len = c; this.v++; this.dirty = false; this.relAt = now;
      return true;
    }
    // slot at unit tape coordinate c (wrapped)
    at(c) {
      const R = this.ring, L = this.len;
      if (!R.length) return null;
      c = ((c % L) + L) % L;
      let lo = 0, hi = R.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R[mid].c <= c) lo = mid; else hi = mid - 1; }
      return R[lo];
    }
  }

  const api = { Universe, SECTORS, series, classify, U, ENG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.VesperaUniverse = api;
})(typeof window !== "undefined" ? window : globalThis);
