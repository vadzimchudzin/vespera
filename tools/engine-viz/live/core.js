/* Vespera Engine Live — core. No DOM, no network.
 * feeds.js (live) or a recording (replay) pushes normalized events; each has rt = receive time, ms.
 * The renderer only reads this state. Facts it relies on, checked against live data on 2026-11-03:
 *  - crypto Up/Down markets resolve on the Chainlink 60 s TWAP stream: Up if TWAP(end) >= TWAP(start);
 *    Gamma's priceToBeat equals the TWAP stream value at the exact start second (5m 22:50 and 22:55 UTC+3);
 *  - the UP and DOWN books mirror each other (UP bid p = DOWN ask 1 − p, same size), so the engine keeps one book in
 *    UP prices and applies DOWN messages mirrored (trades on DOWN only refresh the DOWN book);
 *  - Chainlink 1 s returns are positively autocorrelated (variance ratio 1.7 at 10 s, 3.4 at 60 s over 16 min),
 *    so 1 s volatility understates the risk over minutes; the model uses overlapping 60 s returns;
 *  - taker fee in USDC = shares × rate × p × (1 − p), rate 0.07 (feeSchedule; equals the fee on RTDS trades). */
(function (global) {
  "use strict";
  const UNI = global.VesperaUniverse || (typeof require === "function" ? require("./universe.js") : null);
  const CFG = {
    tickMs: 250,          // model clock; replays use the same grid, so a replay is deterministic
    edgeMin: 0.03,        // paper entry: edge after fee >= 3 probability points
    spreadMax: 0.05, minElapsed: 0.1, minTau: 30, markoutS: 30,
    sigmaWinS: 3600, sigmaH: 60, sigmaSpanS: 300, seriesS: 3900, threadsMax: 14000, threadAgeMs: 16 * 60e3,
  };
  const TF = { "5m": 300, "15m": 900 };
  const fmtPx = (v) => (v == null ? "—" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
  const HOURLY = { bitcoin: "btc", ethereum: "eth", solana: "sol", xrp: "xrp", dogecoin: "doge", hyperliquid: "hype", bnb: "bnb" };

  function parseSlug(slug) {
    let m = /^([a-z0-9]+)-updown-(\d+)([mh])-(\d{9,})$/.exec(slug || "");
    if (m) return { asset: m[1], tf: m[2] + m[3], start: +m[4], dur: +m[2] * (m[3] === "h" ? 3600 : 60) };
    m = /^([a-z]+)-up-or-down-.*-\d{1,2}(am|pm)-et$/.exec(slug || "");
    if (m) return { asset: HOURLY[m[1]] || m[1], tf: "1h", start: null, dur: 3600 };
    return null;
  }

  // Standard normal CDF (Abramowitz–Stegun 7.1.26) and its inverse (Acklam).
  function phi(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + (x < 0 ? -y : y));
  }
  function phiInv(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
    if (p > 0.97575) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // P(TWAP(end) >= K). The final TWAP averages spot over the last 60 s of the window.
  // tau > 60: mean S, variance S²σ²(tau − 40): tau − 60 s of drift, plus 60/3 for the 60 s average.
  // tau <= 60: the first 60 − tau s of the final average are printed already, so the mean is the live
  // TWAP X shifted by (tau/60)(S − aOld), aOld = spot over the seconds that drop out; variance S²σ²tau³/10800.
  const effTime = (tau) => (tau > 60 ? tau - 40 : tau ** 3 / 10800);
  function fair(S, X, aOld, K, sig, tau) {
    if (!(tau > 0) || !(sig > 0)) return null;
    const mean = tau > 60 ? S : X + (tau / 60) * (S - aOld), sd = S * sig * Math.sqrt(effTime(tau));
    return { p: phi((mean - K) / sd), mean, sd };
  }

  // Average price and fee per share to take n shares from levels [[price, size]], best first.
  function take(levels, n, rate, exp, flip) {
    let left = n, cost = 0, fee = 0;
    for (const [p0, s] of levels) {
      const p = flip ? 1 - p0 : p0, q = Math.min(left, s);
      cost += q * p; fee += q * rate * (p * (1 - p)) ** exp; left -= q;
      if (left <= 1e-9) return { px: cost / n, fee: fee / n, worst: p };
    }
    return null;
  }

  class Engine {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, CFG, opts.cfg || {});
      this.kStore = opts.kStore || null; this.onPaper = opts.onPaper || null;
      this.q = []; this.qi = 0; this.now = 0; this.nextTick = 0;
      this.mk = new Map(); this.byTok = new Map(); this.byCond = new Map();
      this.px = {}; this.sig = {}; this.conn = {}; this.feeds = {}; this.notes = [];
      this.trades = []; this.nTrades = 0; this.wallets = new Map();
      this.paper = (opts.paper || []).slice();
      this.focusM = null;
      this.graph = { strands: [], prev: null, sig: [] };
      this.uni = new UNI.Universe();
    }

    // ---- clock ---------------------------------------------------------------------------
    push(e) { this.q.push(e); }
    advance(now) {
      if (!this.nextTick) {
        const first = this.qi < this.q.length ? Math.min(this.q[this.qi].rt, now) : now;
        this.nextTick = Math.ceil(first / this.cfg.tickMs) * this.cfg.tickMs;
      }
      while (this.nextTick <= now) { this.drain(this.nextTick); this.tick(this.nextTick); this.nextTick += this.cfg.tickMs; }
      this.drain(now); this.now = Math.max(this.now, now);
      if (this.qi > 20000) { this.q = this.q.slice(this.qi); this.qi = 0; }
    }
    drain(t) { while (this.qi < this.q.length && this.q[this.qi].rt <= t) this.ingest(this.q[this.qi++]); }

    ingest(e) {
      switch (e.k) {
        case "trade": this.feed("trades", e.rt, e.rt - e.ts * 1000); return this.onTrade(e);
        case "cl": case "tw": this.feed(e.k === "cl" ? "chainlink" : "twap", e.rt, e.snap ? null : e.rt - e.ts); return this.onPx(e);
        case "book": this.feed("clob", e.rt, e.ts ? e.rt - e.ts : null); return this.onBook(e);
        case "pc": this.feed("clob", e.rt, e.ts ? e.rt - e.ts : null); return this.onLevels(e);
        case "ltp": this.feed("clob", e.rt, e.ts ? e.rt - e.ts : null); return this.onLast(e);
        case "res": this.feed("clob", e.rt); return this.onResolved(e);
        case "tick": { const t = this.byTok.get(e.tok); if (t) t.m.tick = e.tick; return; }
        case "mkt": this.feed("gamma", e.rt); return this.onMeta(e);
        case "cat": this.feed("gamma", e.rt); return this.uni.onCatalog(e);
        case "evd": this.feed("gamma", e.rt); return this.uni.onDetails(e);
        case "feed": this.conn[e.name] = e.st; if (e.st !== "open" || e.name !== "snap") this.note(e.rt, `${e.name}: ${e.st}`); return;
        default:
      }
    }
    feed(name, rt, lag) {
      let f = this.feeds[name];
      const s = Math.floor(rt / 1000);
      if (!f) f = this.feeds[name] = { n: 0, sec: new Float64Array(120), at: s, last: 0, lag: [] };
      if (s - f.at > 120) { f.sec.fill(0); f.at = s; }
      while (f.at < s) { f.at++; f.sec[f.at % 120] = 0; }
      f.sec[s % 120]++; f.n++; f.last = Math.max(f.last, rt);
      if (lag != null && isFinite(lag)) { f.lag.push(lag); if (f.lag.length > 80) f.lag.shift(); }
    }
    note(rt, s) { this.notes.push([rt, s]); if (this.notes.length > 80) this.notes.shift(); }

    // ---- markets -------------------------------------------------------------------------
    market(slug) {
      let m = this.mk.get(slug);
      if (m) return m;
      const p = parseSlug(slug);
      if (!p || p.start == null || !TF[p.tf]) return null;
      m = { slug, asset: p.asset, tf: p.tf, start: p.start, dur: p.dur, end: p.start + p.dur, toks: null, cond: null,
        fee: 0.07, fexp: 1, tick: null, min: 5, twap: null, K: null, kSrc: null, ptb: null, kOk: null, endTw: null, rule: null,
        win: null, winSrc: null, bids: new Map(), asks: new Map(), lvl: new Map(), bookN: 0, bookRt: 0, bb: null, ba: null, mid: null,
        ltp: null, n: 0, usd: 0, wal: new Set(), recent: [], last: null, path: [], fvPath: [], mod: null, exe: null, pos: null };
      if (this.kStore) { const k = this.kStore.get(slug); if (k != null) { m.K = k; m.kSrc = "twap·кэш"; } }
      m.pos = this.paper.find((x) => x.slug === slug) || null;
      this.mk.set(slug, m);
      this.tryK(m, this.now);
      return m;
    }
    live(asset, tf, now = this.now) {
      const d = TF[tf], s = Math.floor(now / 1000 / d) * d;
      return this.market(`${asset}-updown-${tf}-${s}`);
    }
    onMeta(e) {
      const m = this.market(e.slug);
      if (!m) return;
      if (e.toks && e.toks[0] && !m.toks) { m.toks = e.toks; e.toks.forEach((t, i) => this.byTok.set(t, { m, i })); }
      if (e.cond) { m.cond = e.cond; this.byCond.set(e.cond, m); }
      if (e.fee != null) m.fee = e.fee;
      if (e.fexp != null) m.fexp = e.fexp;
      if (e.tick != null && m.tick == null) m.tick = e.tick;
      if (e.min != null) m.min = e.min;
      if (e.twap != null) m.twap = e.twap;
      if (e.ptb != null && m.ptb == null) {
        m.ptb = e.ptb;
        if (m.K == null) { m.K = e.ptb; m.kSrc = "gamma"; }
        else {
          m.kOk = Math.abs(m.K - e.ptb) < 1e-6;
          this.note(e.rt, `${m.slug}: K ${m.kOk ? "= gamma priceToBeat ✓" : `≠ gamma, Δ ${(m.K - e.ptb).toFixed(4)}`}`);
        }
        this.ruleCheck(m, e.rt);
      }
      if (e.win != null && m.win == null) this.official(m, e.win, "gamma", e.rt);
    }

    // ---- trades: every fill on every market becomes one thread ---------------------------------
    // p = price of outcome 0 (UP / YES / the first team), up = exposure to outcome 0 (buy it or sell outcome 1)
    onTrade(e) {
      if (!(e.price > 0) || !(e.size > 0)) return;
      const info = parseSlug(e.slug), zero = info ? e.out === "Up" : e.oi != null ? e.oi === 0 : e.out === "Yes";
      const T = { id: ++this.nTrades, rt: e.rt, ts: e.ts, slug: e.slug, ev: e.ev || "", cond: e.cond || "", tok: e.tok || "", oi: e.oi, q: e.q || "",
        p: zero ? e.price : 1 - e.price, up: zero === (e.side === "BUY"), usd: e.price * e.size, w: e.w, name: e.name, side: e.side, out: e.out,
        price: e.price, size: e.size, fee: e.fee, s: null };
      if (info) {
        const start = info.start != null ? info.start : e.ts - (e.ts % 3600);
        Object.assign(T, { a: info.asset, tf: info.tf, st: start, dur: info.dur, end: start + info.dur, prog: Math.max(-0.25, Math.min(1, (e.ts - start) / info.dur)) });
      }
      T.s = this.uni.onTrade(T);
      this.trades.push(T);
      const W = this.wallets.get(e.w) || { w: e.w, name: e.name, usd: 0, n: 0, net: 0, fee: 0, last: 0, first: e.rt };
      W.usd += T.usd; W.n++; W.net += T.up ? T.usd : -T.usd; W.last = e.rt; if (e.name) W.name = e.name; if (e.fee) W.fee += e.fee;
      this.wallets.set(e.w, W);
      const m = info && info.start != null && TF[info.tf] ? this.market(e.slug) : null;
      if (m) { m.n++; m.usd += T.usd; m.wal.add(e.w); m.last = T; m.recent.push(T); if (m.recent.length > 48) m.recent.shift(); }
    }

    // ---- Chainlink spot and 60 s TWAP ----------------------------------------------------
    onPx(e) {
      if (!(e.v > 0)) return;
      const s = this.px[e.sym] || (this.px[e.sym] = { cl: [], tw: [] }), a = s[e.k];
      if (!a.length || e.ts > a[a.length - 1][0]) a.push([e.ts, e.v]);
      else {  // snapshot history can arrive after live points: insert in order, skip duplicates
        let lo = 0, hi = a.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid][0] < e.ts) lo = mid + 1; else hi = mid; }
        if (lo < a.length && a[lo][0] === e.ts) return;
        a.splice(lo, 0, [e.ts, e.v]);
      }
      if (a.length > this.cfg.seriesS * 1.2) a.splice(0, a.length - this.cfg.seriesS);
      if (e.k === "tw" && e.ts % 300000 === 0) for (const m of this.mk.values()) if (m.asset === e.sym) {
        if (m.start * 1000 === e.ts) this.tryK(m, e.rt);
        if (m.end * 1000 === e.ts) this.tryEnd(m, e.rt);
      }
    }
    at(sym, k, ts) {
      const a = this.px[sym] && this.px[sym][k];
      if (!a) return null;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid][0] < ts) lo = mid + 1; else hi = mid; }
      return lo < a.length && a[lo][0] === ts ? a[lo][1] : null;
    }
    mean(sym, from, to) {
      const a = this.px[sym] && this.px[sym].cl;
      let s = 0, n = 0;
      if (a) for (let i = a.length - 1; i >= 0 && a[i][0] > from; i--) if (a[i][0] <= to) { s += a[i][1]; n++; }
      return n ? s / n : null;
    }
    tryK(m, rt) {
      const v = this.at(m.asset, "tw", m.start * 1000);
      if (v == null) return;
      if (m.K == null || m.kSrc === "gamma") {
        m.K = v; m.kSrc = "twap";
        if (this.kStore) this.kStore.set(m.slug, v);
        this.note(rt, `${m.slug}: K = ${fmtPx(v)} (twap в секунду старта)`);
      }
      if (m.ptb != null) m.kOk = Math.abs(v - m.ptb) < 1e-6;
      this.ruleCheck(m, rt);
    }
    tryEnd(m, rt) {
      if (m.endTw != null) return;
      const v = this.at(m.asset, "tw", m.end * 1000);
      if (v == null) return;
      m.endTw = v; this.ruleCheck(m, rt);
    }
    ruleCheck(m, rt) {
      if (m.rule != null || m.endTw == null || m.K == null) return;
      m.rule = m.endTw >= m.K ? 0 : 1;
      this.note(rt, `${m.slug}: twap(конец) ${fmtPx(m.endTw)} ${m.rule ? "<" : "≥"} K ${fmtPx(m.K)} → ${m.rule ? "DOWN" : "UP"}`);
      this.settle(m, rt);
    }
    official(m, win, src, rt) {
      m.win = win; m.winSrc = src;
      this.note(rt, `${m.slug}: итог ${win ? "DOWN" : "UP"} (${src})${m.rule == null ? "" : m.rule === win ? " = правило ✓" : " ≠ правило ✗"}`);
      this.settle(m, rt);
    }
    onResolved(e) {
      const m = this.byCond.get(e.cond);
      if (m && m.toks && m.win == null) { const i = m.toks.indexOf(e.win); if (i >= 0) this.official(m, i, "clob", e.rt); }
    }

    // ---- order book (UP token; the DOWN book is its mirror) -------------------------------
    onBook(e) {
      const t = this.byTok.get(e.tok);
      if (!t) { this.uni.onBook(e); return; }
      const m = t.m, old = [m.bids, m.asks], up = (l) => l.map(([p, s]) => [Math.round(p * 1e4), s]);
      const dn = (l) => l.map(([p, s]) => [Math.round((1 - p) * 1e4), s]);
      m.bids = new Map(t.i === 0 ? up(e.bids) : dn(e.asks));
      m.asks = new Map(t.i === 0 ? up(e.asks) : dn(e.bids));
      [["b", m.bids, old[0]], ["a", m.asks, old[1]]].forEach(([side, cur, prev]) => {
        for (const [k, s] of cur) if (prev.get(k) !== s) m.lvl.set(side + k, e.rt);
        for (const k of prev.keys()) if (!cur.has(k)) m.lvl.set(side + k, e.rt);
      });
      m.bookN++; m.bookRt = e.rt; this.best(m, e.rt);
    }
    onLevels(e) {
      const touched = new Set();
      for (const [tok, p, s, side] of e.ch) {
        const t = this.byTok.get(tok);
        if (!t) { this.uni.onLevel(tok, p, s, side, e.rt); continue; }
        const m = t.m, sd = t.i === 0 ? side : side === "b" ? "a" : "b", book = sd === "b" ? m.bids : m.asks;
        const k = Math.round((t.i === 0 ? p : 1 - p) * 1e4);
        if (s > 0) { if (book.get(k) === s) continue; book.set(k, s); } else if (!book.delete(k)) continue;
        m.lvl.set(sd + k, e.rt); m.bookN++; touched.add(m);
      }
      for (const m of touched) { m.bookRt = e.rt; this.best(m, e.rt); }
    }
    onLast(e) {
      const t = this.byTok.get(e.tok);
      if (t) t.m.ltp = { p: t.i === 0 ? e.p : 1 - e.p, s: e.s, rt: e.rt };
    }
    best(m, rt) {
      let bb = -1, ba = Infinity;
      for (const k of m.bids.keys()) if (k > bb) bb = k;
      for (const k of m.asks.keys()) if (k < ba) ba = k;
      const nb = bb < 0 ? null : bb / 1e4, na = ba === Infinity ? null : ba / 1e4;
      const mid = nb != null && na != null ? (nb + na) / 2 : null;
      if (m === this.focusM && m.mid != null && mid != null && mid !== m.mid) this.strand("book", rt, mid - m.mid);
      m.bb = nb; m.ba = na; m.mid = mid;
    }
    levels(m) {
      if (m._lv && m._lvN === m.bookN) return m._lv;
      const conv = (map, dir) => [...map].map(([k, s]) => [k / 1e4, s]).sort((x, y) => dir * (x[0] - y[0]));
      m._lv = { bids: conv(m.bids, -1), asks: conv(m.asks, 1) }; m._lvN = m.bookN;
      return m._lv;
    }

    // ---- model, executable price, paper test --------------------------------------------
    tick(now) {
      const sec = now / 1000, whole = now % 1000 === 0;
      if (whole) for (const sym in this.px) this.sigma(sym, now);
      this.focusM = this.live("btc", "15m", now);
      for (const m of this.mk.values()) {
        if (sec < m.start - m.dur || sec > m.end + 3 * m.dur) continue;
        if (sec >= m.start && sec < m.end) {
          this.model(m, now); this.exec(m); this.decide(m, now);
          if (whole) { m.path.push([now, m.mid]); m.fvPath.push([now, m.mod && m.mod.fv]); }
        } else if (sec >= m.end && m.mod && m.mod.fv != null) { m.mod = Object.assign({}, m.mod, { fv: null, why: "окно закрыто", tau: 0 }); }
        const P = m.pos;
        if (P && P.mo == null && now >= P.rt + this.cfg.markoutS * 1000 && m.mid != null) {
          P.mid30 = m.mid; P.mo = P.side === 0 ? m.mid - P.px : 1 - m.mid - P.px; this.paperChanged();
        }
      }
      const fm = this.focusM;
      if (whole && fm && fm.mod) { this.graph.sig.push([now, fm.mod.sig, fm.mod.isig]); if (this.graph.sig.length > 1200) this.graph.sig.shift(); }
      if (now % 5000 === 0) this.prune(now);
    }
    // Realized volatility per √s of Chainlink spot: overlapping 60 s log returns over the last hour (needs 5 min of data);
    // the 1 s figure and the variance ratio are kept to show how much the 1 s series understates it.
    sigma(sym, now) {
      const a = this.px[sym].cl, H = this.cfg.sigmaH * 1000, from = now - this.cfg.sigmaWinS * 1000;
      let i0 = a.length - 1;
      while (i0 > 0 && a[i0][0] > now) i0--;
      let n = 0, ss = 0, n1 = 0, s1 = 0, j = i0, lo = i0, span = 0;
      for (let i = i0; i >= 0 && a[i][0] >= from; i--) {
        lo = i;
        if (i > 0) { const dt = (a[i][0] - a[i - 1][0]) / 1000; if (dt > 0 && dt <= 10) { const r = Math.log(a[i][1] / a[i - 1][1]); s1 += (r * r) / dt; n1++; } }
        while (j > 0 && a[j][0] > a[i][0] - H) j--;
        if (a[j][0] > a[i][0] - H || a[j][0] < from) continue;
        const dt = (a[i][0] - a[j][0]) / 1000;
        if (dt > this.cfg.sigmaH + 3) continue;
        const r = Math.log(a[i][1] / a[j][1]);
        ss += (r * r) / dt; n++;
      }
      if (i0 >= 0 && a.length) span = (a[i0][0] - a[lo][0]) / 1000;
      const v = n && span >= this.cfg.sigmaSpanS ? Math.sqrt(ss / n) : null, v1 = n1 ? Math.sqrt(s1 / n1) : null;
      this.sig[sym] = { v, n, span, v1, vr: v && v1 ? (v / v1) ** 2 : null };
    }
    model(m, now) {
      const s = this.px[m.asset], sg = this.sig[m.asset], tau = m.end - now / 1000;
      const S = s && s.cl.length ? s.cl[s.cl.length - 1] : null, X = s && s.tw.length ? s.tw[s.tw.length - 1] : null;
      let why = null;
      if (m.twap === false) why = "рынок без twap";
      else if (!S) why = "нет chainlink";
      else if (now - S[0] > 8000) why = "chainlink молчит";
      else if (m.K == null) why = "K неизвестна";
      else if (!sg || sg.v == null) why = `σ60: прогрев ${Math.max(0, Math.ceil(this.cfg.sigmaSpanS - (sg ? sg.span : 0)))} с`;
      else if (tau <= 60 && !X) why = "нет twap";
      const mod = { tau, S: S && S[1], X: X && X[1], K: m.K, sig: sg && sg.v, sig1: sg && sg.v1, vr: sg && sg.vr, n: sg ? sg.n : 0,
        span: sg ? sg.span : 0, fv: null, why, mean: null, sd: null, isig: null, aOld: null };
      if (!why) {
        const aOld = tau <= 60 ? this.mean(m.asset, now - 60000, now - 60000 + tau * 1000) : null;
        const f = fair(mod.S, mod.X, aOld == null ? mod.X : aOld, m.K, mod.sig, tau);
        if (f) {
          mod.fv = f.p; mod.mean = f.mean; mod.sd = f.sd; mod.aOld = aOld;
          if (m.mid != null && m.mid > 0.02 && m.mid < 0.98 && Math.abs(m.mid - 0.5) > 0.005) {
            const iv = (f.mean - m.K) / (mod.S * Math.sqrt(effTime(tau)) * phiInv(m.mid));
            mod.isig = iv > 0 && isFinite(iv) ? iv : null;
          }
          if (m === this.focusM) this.attribute(m, mod, now);
        } else mod.why = "σ = 0";
      }
      m.mod = mod;
    }
    attribute(m, mod, now) {
      const p = this.graph.prev, cur = { slug: m.slug, S: mod.S, X: mod.X, a: mod.aOld == null ? mod.X : mod.aOld, K: mod.K, sig: mod.sig, tau: mod.tau };
      this.graph.prev = cur;
      if (!p || p.slug !== m.slug) { this.strand("K", now, 0.02); return; }
      const f = (o) => { const r = fair(o.S, o.X, o.a, o.K, o.sig, o.tau); return r ? r.p : 0; }, base = f(p);
      const parts = { S: { S: cur.S }, X: { X: cur.X, a: cur.a }, sig: { sig: cur.sig }, tau: { tau: cur.tau } };
      for (const k in parts) { const c = f(Object.assign({}, p, parts[k])) - base; if (Math.abs(c) > 2e-5) this.strand(k, now, c); }
    }
    strand(link, rt, c) { const s = this.graph.strands; s.push({ link, rt, c }); if (s.length > 600) s.splice(0, s.length - 600); }
    exec(m) {
      if (!m.bookRt) { m.exe = null; return; }
      const L = this.levels(m), n = m.min || 5, fv = m.mod && m.mod.fv;
      const up = take(L.asks, n, m.fee, m.fexp, false), dn = take(L.bids, n, m.fee, m.fexp, true);
      m.exe = { n, up, dn, eu: fv != null && up ? fv - up.px - up.fee : null, ed: fv != null && dn ? 1 - fv - dn.px - dn.fee : null,
        spread: m.ba != null && m.bb != null ? m.ba - m.bb : null };
    }
    decide(m, now) {
      const x = m.exe, mod = m.mod, c = this.cfg;
      if (m.pos || !x || !mod || mod.fv == null) return;
      if ((now / 1000 - m.start) / m.dur < c.minElapsed || mod.tau < c.minTau) return;
      if (x.spread == null || x.spread > c.spreadMax + 1e-9) return;
      const side = x.eu != null && (x.ed == null || x.eu >= x.ed) ? 0 : 1, e = side === 0 ? x.eu : x.ed, f = side === 0 ? x.up : x.dn;
      if (e == null || e < c.edgeMin) return;
      m.pos = { slug: m.slug, asset: m.asset, tf: m.tf, side, n: x.n, px: f.px, fee: f.fee, fv: mod.fv, edge: e, rt: now,
        tau: mod.tau, K: mod.K, S: mod.S, X: mod.X, sig: mod.sig, mid: m.mid, mo: null, rule: null, win: null, pnl: null, ok: null };
      this.paper.push(m.pos);
      this.strand("edge", now, e);
      this.note(now, `paper: ${m.slug} ${side ? "DOWN" : "UP"} ${x.n} @ ${f.px.toFixed(3)} · fv ${mod.fv.toFixed(3)} · edge ${(e * 100).toFixed(1)}%`);
      this.paperChanged();
    }
    settle(m, rt) {
      const P = m.pos || this.paper.find((x) => x.slug === m.slug);
      if (!P) return;
      P.rule = m.rule; P.win = m.win;
      const out = m.win != null ? m.win : m.rule;
      if (out != null) P.pnl = P.n * ((out === P.side ? 1 : 0) - P.px - P.fee);
      P.ok = m.win != null && m.rule != null ? m.win === m.rule : null;
      P.final = m.win != null;
      this.paperChanged();
    }
    paperChanged() { if (this.onPaper) this.onPaper(this.paper); }
    stats() {
      const P = this.paper, done = P.filter((p) => p.pnl != null), avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      return { n: P.length, done: done.length, wins: done.filter((p) => p.pnl > 0).length, pnl: done.reduce((s, p) => s + p.pnl, 0),
        edge: avg(P.map((p) => p.edge)), mo: avg(P.filter((p) => p.mo != null).map((p) => p.mo)), bad: P.filter((p) => p.ok === false).length,
        open: P.length - P.filter((p) => p.final).length };
    }
    prune(now) {
      const T = this.trades, cut = now - this.cfg.threadAgeMs;
      let i = 0;
      while (i < T.length && (T[i].rt < cut || T.length - i > this.cfg.threadsMax)) i++;
      if (i) T.splice(0, i);
      for (const m of this.mk.values()) for (const [k, t] of m.lvl) if (t < now - 15000) m.lvl.delete(k);
      this.uni.prune(now);
      const gs = this.graph.strands; while (gs.length && gs[0].rt < now - 60000) gs.shift();
      if (now % 60000) return;
      for (const [slug, m] of this.mk) if (m.end < now / 1000 - 3600) {
        this.mk.delete(slug); if (m.toks) m.toks.forEach((t) => this.byTok.delete(t)); if (m.cond) this.byCond.delete(m.cond);
      }
      for (const [w, W] of this.wallets) if (W.last < now - 3600e3) this.wallets.delete(w);
    }
  }

  const api = { Engine, CFG, TF, parseSlug, fair, phi, phiInv, take, effTime, fmtPx };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.VesperaCore = api;
})(typeof window !== "undefined" ? window : globalThis);
