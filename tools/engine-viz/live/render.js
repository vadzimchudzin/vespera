/* Vespera Engine Live — renderer. Canvas 2D, no dependencies; draws an Engine (core.js) at a given time.
 *  ① trade web: each fill on a crypto Up/Down market is one thread: wallet (left edge) → bend at (moment in its window,
 *     UP price of the fill) → its market on the ring. Teal = exposure to UP (buy Up / sell Down), orange = to DOWN.
 *     A thread lights up when its fill arrives and cools over ~5 s; width = notional.
 *  ② ring: one slot per market window (BTC 15m and 5m: previous, live, next) with live log lines.
 *  ③ rays: the live BTC books level by level (asks above, bids below; glow = level just changed); other slots: last fills.
 *  ④ tiles: feeds, Chainlink, model graph, book, wallets, paper test. */
(function (global) {
  "use strict";
  const MONO = '"JetBrains Mono","DejaVu Sans Mono","Liberation Mono",monospace';
  const INK = "235,235,228", UP = "57,214,176", DN = "255,106,61", OURS = "255,211,77", WHITE = "255,255,255";
  const UPL = "190,250,232", DNL = "255,214,190";   // light tints of UP and DN for sparks
  const TZ = "Etc/GMT-3", TZL = "UTC+3", HOT = 12000, TF = { "5m": 300, "15m": 900 }, TAU = Math.PI * 2;
  const C = global.VesperaCore, fp = C.fmtPx;
  // colour strings are cached per 1/255 of alpha (the canvas keeps 8 bits anyway): no new string per stroke, less GC
  const RGBA = {};
  const rgba = (c, a) => {
    const q = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255), A = RGBA[c] || (RGBA[c] = new Array(256));
    return A[q] || (A[q] = `rgba(${c},${(q / 255).toFixed(3)})`);
  };
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ms, sec) => new Date(ms).toLocaleTimeString("en-GB", sec ? { timeZone: TZ, hour12: false } : { hour: "2-digit", minute: "2-digit", timeZone: TZ, hour12: false });
  const utc = (ms) => new Date(ms).toISOString().slice(11, 19);
  const mmss = (s) => (s == null ? "—" : `${pad(Math.floor(Math.max(0, s) / 60))}:${pad(Math.floor(Math.max(0, s) % 60))}`);
  const p3 = (x) => (x == null ? "—" : x >= 0.9995 ? "1.00" : x.toFixed(3).replace(/^0\./, "."));
  const pct = (x, d = 1) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
  const usd = (x) => { const a = Math.abs(x || 0); return (x < 0 ? "−" : "") + (a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(a / 1e3).toFixed(1)}k` : a >= 1e3 ? `$${(a / 1e3).toFixed(2)}k` : `$${a.toFixed(a < 100 ? 2 : 0)}`); };
  const money = (x) => (x == null ? "—" : `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`);
  const dlt = (v, ref) => (v == null || ref == null ? "—" : `${v - ref >= 0 ? "+" : "−"}${fp(Math.abs(v - ref))}`);
  const sci = (v) => (v == null ? "—" : v.toExponential(1).replace("e-", "e−"));
  const lerp = (a, b, t) => a + (b - a) * t;
  const short = (W) => (W.name ? W.name.slice(0, 15) : `${W.w.slice(0, 6)}…${W.w.slice(-4)}`);
  function hash(s, seed = 2166136261) {
    let h = seed >>> 0; s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function tx(ctx, s, x, y, size, color, align = "left", weight = "") {
    ctx.font = `${weight ? weight + " " : ""}${size}px ${MONO}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y);
  }
  function tracePath(c, G) { c.moveTo(G[0], G[1]); c.bezierCurveTo(G[2], G[3], G[4], G[5], G[6], G[7]); c.bezierCurveTo(G[8], G[9], G[10], G[11], G[12], G[13]); }
  // the part of a thread from its wallet to parameter u: de Casteljau split of the cubic that u falls in
  function tracePart(c, G, u) {
    let o = 0, t = u * 2;
    c.moveTo(G[0], G[1]);
    if (u >= 0.5) { c.bezierCurveTo(G[2], G[3], G[4], G[5], G[6], G[7]); o = 6; t = u * 2 - 1; }
    const ax = G[o] + (G[o + 2] - G[o]) * t, ay = G[o + 1] + (G[o + 3] - G[o + 1]) * t, bx = G[o + 2] + (G[o + 4] - G[o + 2]) * t, by = G[o + 3] + (G[o + 5] - G[o + 3]) * t;
    const qx = G[o + 4] + (G[o + 6] - G[o + 4]) * t, qy = G[o + 5] + (G[o + 7] - G[o + 5]) * t, dx = ax + (bx - ax) * t, dy = ay + (by - ay) * t;
    c.bezierCurveTo(ax, ay, dx, dy, dx + (bx + (qx - bx) * t - dx) * t, dy + (by + (qy - by) * t - dy) * t);
  }
  function pointAt(G, u) {
    const o = u < 0.5 ? 0 : 6, t = u < 0.5 ? u * 2 : (u - 0.5) * 2, m = 1 - t;
    const P = (k) => m * m * m * G[o + k] + 3 * m * m * t * G[o + 2 + k] + 3 * m * t * t * G[o + 4 + k] + t * t * t * G[o + 6 + k];
    return [P(0), P(1)];
  }
  const bucket = (t, age) => (t.up ? 16 : 0) + (t.usd < 5 ? 0 : t.usd < 50 ? 1 : t.usd < 500 ? 2 : 3) * 4 + (age < 60e3 ? 0 : age < 240e3 ? 1 : age < 480e3 ? 2 : 3);
  // Every thread stroke stays at or under 1 device px with plain alpha blending: Skia draws those on its fast hairline
  // path (additive "lighter" strokes cost ~10× more). A fill's size reads as brightness, not width.
  // a spark flies at ~1300 px/s (0.6–1.3 s), fast out of the wallet and slowing into its market
  const FLY = 1300, fly = (age, T) => 1 - (1 - Math.min(1, age / T._fl)) ** 1.5, szN = (usd) => Math.min(1, Math.log10(1 + usd) / 4);
  function styleBucket(c, b, d) {
    const wb = (b >> 2) & 3, ab = b & 3;
    c.strokeStyle = rgba(b >= 16 ? UP : DN, 0.07 * [0.75, 1, 1.35, 1.8][wb] * [1, 0.6, 0.38, 0.2][ab]); c.lineWidth = [0.5, 0.65, 0.85, 1][wb] / d;
  }
  const canvasOf = () => (global.document ? global.document.createElement("canvas") : new OffscreenCanvas(1, 1));

  const LEGEND = ["VESPERA · ENGINE LIVE",
    "только живые данные Polymarket: rtds сделки и chainlink, clob стаканы, gamma рынки — без прокси и симуляций",
    "① нить = реальная сделка: кошелёк → (момент в её окне, цена UP) → её рынок на кольце · бирюза = на UP, оранж = на DOWN · искра летит к рынку, яркость = $",
    "② кольцо: рынки up/down 5m и 15m · ③ лучи: стакан BTC по уровням, у остальных — последние сделки · ④ панели ниже"];

  const SLOTS = [];
  for (const a of ["eth", "sol", "xrp"]) for (const tf of ["15m", "5m"]) SLOTS.push({ a, tf, rel: 0, w: 1 });
  for (const tf of ["15m", "5m"]) for (const rel of [-1, 0, 1]) SLOTS.push({ a: "btc", tf, rel, w: rel ? 0.85 : tf === "15m" ? 2.9 : 2.8, focus: !rel });
  for (const a of ["doge", "hype", "bnb"]) for (const tf of ["15m", "5m"]) SLOTS.push({ a, tf, rel: 0, w: 1 });
  SLOTS.push({ other: true, w: 1 });

  function geometry(W, H) {
    const mainH = Math.round(H * 0.735), R = W * 0.62, cx = W * 0.47 + R, cy = mainH * 0.36, band = W * 0.122;
    const arcX = (y, r) => cx - Math.sqrt(Math.max(r * r - (y - cy) ** 2, 0));
    const g = { W, H, mainH, R, Rin: R - band, cx, cy, arcX, top: 64, bottom: mainH - 28, x0: 64 };
    g.yP = (p) => g.top + 8 + (1 - p) * (g.bottom - g.top - 16);
    g.xW = (prog, y) => g.x0 + ((prog + 0.25) / 1.25) * (arcX(y, R) - 24 - g.x0);
    return g;
  }
  function tile(ctx, x, y, w, h, cmd, meta, cap) {
    ctx.fillStyle = "#0b0b0d"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(INK, 0.09); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.beginPath(); ctx.arc(x + 10, y + 12, 2.6, 0, TAU); ctx.fillStyle = rgba(UP, 0.9); ctx.fill();
    tx(ctx, `~ % ${cmd}`, x + 18, y + 15, 10, rgba(INK, 0.9));
    tx(ctx, meta, x + w - 8, y + 15, 9, rgba(INK, 0.45), "right");
    tx(ctx, cap, x + 10, y + 30, 8.5, rgba(INK, 0.5));
  }

  class Renderer {
    constructor(canvas, eng, opts = {}) {
      this.c = canvas; this.ctx = canvas.getContext("2d"); this.E = eng;
      this.o = Object.assign({ dpr: 1, mode: "live" }, opts);
      this.base = null; this.baseKey = ""; this.baseAt = 0; this.baseTo = 0; this.lkey = ""; this.topW = []; this.topAt = -Infinity; this.stAt = -Infinity;
      this.back = null; this.job = null; this.tiny = null; this.ringC = null; this.ringK = null; this.tileK = null; this.pulse = {};
      this.resize();
    }
    resize() {
      const W = this.o.width || global.innerWidth, H = this.o.height || global.innerHeight, d = this.o.dpr;
      this.W = W; this.H = H; this.c.width = Math.round(W * d); this.c.height = Math.round(H * d);
      if (this.c.style) { this.c.style.width = `${W}px`; this.c.style.height = `${H}px`; }
      this.g = geometry(W, H);
      const tot = SLOTS.reduce((s, x) => s + x.w, 0), unit = (this.g.mainH - 16) / tot;
      let y = 8; this.idx = {};
      this.slots = SLOTS.map((s, i) => {
        const o = Object.assign({}, s, { i, y0: y, h: s.w * unit }); o.y1 = y + o.h; o.yc = y + o.h / 2; y = o.y1;
        this.idx[s.other ? "other" : s.a + s.tf + s.rel] = i; return o;
      });
      const g = this.g, x0 = Math.floor(g.cx - g.R - 4), x1 = Math.min(W, Math.ceil(Math.max(g.arcX(0, g.Rin), g.arcX(g.mainH, g.Rin)) + 4));
      this.rb = { x0, w: x1 - x0 };
      this.baseKey = ""; this.lkey = ""; this.stAt = -Infinity; this.ringK = null; this.tileK = null; this.legW = 0;
    }
    slotOf(T, now) {
      if (!T.a || !TF[T.tf]) return this.idx.other;
      if (T.a === "btc") { const d = TF[T.tf], cur = Math.floor(now / 1000 / d) * d; return this.idx[`btc${T.tf}${Math.max(-1, Math.min(1, Math.round((T.st - cur) / d)))}`]; }
      const i = this.idx[`${T.a}${T.tf}0`];
      return i == null ? this.idx.other : i;
    }
    market(s, now) {
      if (s.other) return null;
      const d = TF[s.tf], st = Math.floor(now / 1000 / d) * d + s.rel * d;
      return this.E.mk.get(`${s.a}-updown-${s.tf}-${st}`) || null;
    }
    geom(T, now) {
      if (T._k === this.lkey) return T._g;
      const g = this.g, s = this.slots[this.slotOf(T, now)], hw = hash(T.w), hx = hash(T.w, 99), ht = hash(T.id, 7);
      const wx = 8 + 16 * hx, wy = g.top + hw * (g.bottom - g.top), by = g.yP(T.p), bx = g.xW(T.prog, by);
      const ry = s.yc + (T.up ? -1 : 1) * s.h * (0.06 + 0.34 * ht), rx = g.arcX(ry, g.R) + 1;
      T._g = [wx, wy, lerp(wx, bx, 0.55), wy, lerp(bx, wx, 0.25), by, bx, by, lerp(bx, rx, 0.4), by, lerp(rx, bx, 0.3), ry, rx, ry];
      T._fl = Math.min(FLY, Math.max(600, (Math.hypot(bx - wx, by - wy) + Math.hypot(rx - bx, ry - by)) / 1.3));
      T._k = this.lkey;
      return T._g;
    }
    slotStats(now) {
      if (now - this.stAt < 1000 && now >= this.stAt) return this.st;
      const st = this.slots.map(() => ({ n: 0, usd: 0, w: new Set() }));
      for (const t of this.E.trades) { if (t.rt > now) break; const o = st[this.slotOf(t, now)]; o.n++; o.usd += t.usd; o.w.add(t.w); }
      this.st = st; this.stAt = now;
      return st;
    }
    recent(now) {  // newest fills per slot, at most 48 each, from the last 3 minutes
      const out = this.slots.map(() => []), T = this.E.trades;
      for (let i = T.length - 1, k = 0; i >= 0 && k < 4000; i--, k++) {
        const t = T[i]; if (t.rt > now) continue; if (now - t.rt > 180e3) break;
        const a = out[this.slotOf(t, now)]; if (a.length < 48) a.push(t);
      }
      return out;
    }

    draw(now) {
      const ctx = this.ctx, g = this.g, d = this.o.dpr;
      this.lkey = `${this.W}x${this.H}:${Math.floor(now / 300000)}`;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      if (now - this.topAt > 1000 || now < this.topAt) { this.topW = [...this.E.wallets.values()].sort((a, b) => b.usd - a.usd).slice(0, 8); this.topAt = now; }
      this.slotStats(now); this.rec = this.recent(now);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.W, g.mainH); ctx.clip();
      this.baseLayer(now); ctx.drawImage(this.base, 0, 0, this.W, g.mainH);
      this.web(ctx, now); this.rays(ctx, now); this.ring(ctx, now); this.nowBox(ctx, now); this.legend(ctx);
      ctx.restore();
      // the panels are numbers: 8 redraws a second keep them live at a fraction of the cost, and the canvas keeps them between
      const tk = Math.floor((now + 60) / 125);
      if (tk !== this.tileK) { this.tileK = tk; this.tiles(ctx, now); }
    }

    // ① ------------------------------------------------------------------------------------
    grid(c) {
      const g = this.g;
      c.lineWidth = 0.5;
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const y = g.yP(p);
        c.setLineDash(p === 0.5 ? [2, 4] : [1, 6]); c.strokeStyle = rgba(INK, p === 0.5 ? 0.2 : 0.11);
        c.beginPath(); c.moveTo(g.x0, y); c.lineTo(g.arcX(y, g.R) - 8, y); c.stroke();
        tx(c, p === 1 ? "UP 1.00" : p === 0 ? "DOWN 0" : p.toFixed(2).replace(/^0/, ""), g.x0 + 3, y - 3, 8.5, rgba(INK, 0.42));
      }
      c.setLineDash([]);
      for (let k = -3; k <= 15; k++) {
        const prog = k / 15, major = k % 5 === 0;
        c.strokeStyle = rgba(INK, k < 0 ? 0.03 : major ? 0.085 : 0.035); c.beginPath();
        for (let y = g.top; y <= g.bottom; y += 8) { const x = g.xW(prog, y); y === g.top ? c.moveTo(x, y) : c.lineTo(x, y); }
        c.stroke();
        if (major && k >= 0) tx(c, `${k}:00 · ${mmss(k * 20)}`, g.xW(prog, g.bottom), g.bottom + 14, 8.5, rgba(INK, 0.38), "center");
      }
      tx(c, "до старта", g.xW(-0.125, g.bottom), g.bottom + 14, 8.5, rgba(INK, 0.3), "center");
      tx(c, "момент сделки в окне 15m · 5m →", g.xW(1, g.bottom) - 4, g.bottom + 25, 8, rgba(INK, 0.3), "right");
    }
    // Background, grid and the 16-minute trace live in one opaque layer. The trace ages, so the layer is rebuilt every 30 s
    // and when the BTC slots roll; the rebuild runs in a back buffer, 700 threads a frame, so no single frame stalls.
    baseStart(cv, now) {
      const d = this.o.dpr, c = cv.getContext("2d", { alpha: false }), list = [];
      c.setTransform(d, 0, 0, d, 0, 0); c.fillStyle = "#060607"; c.fillRect(0, 0, this.W, this.g.mainH); this.grid(c);
      for (const t of this.E.trades) { if (now - t.rt < HOT) break; list.push(t); }
      return { c, now, list, i: 0, key: this.lkey, maxId: list.length ? list[list.length - 1].id : 0 };
    }
    baseStep(J, n) {
      const d = this.o.dpr, groups = new Map(), end = Math.min(J.list.length, J.i + n);
      for (; J.i < end; J.i++) { const t = J.list[J.i], b = bucket(t, J.now - t.rt); let a = groups.get(b); if (!a) groups.set(b, (a = [])); a.push(t); }
      J.c.setTransform(d, 0, 0, d, 0, 0);
      for (const [b, arr] of groups) { styleBucket(J.c, b, d); J.c.beginPath(); for (const t of arr) tracePath(J.c, this.geom(t, J.now)); J.c.stroke(); }
      // canvas 2D records and rasterises lazily: copying one pixel out makes this chunk rasterise now, not all at the swap
      if (n !== Infinity) (this.tiny || (this.tiny = canvasOf())).getContext("2d").drawImage(J.c.canvas, 0, 0, 1, 1, 0, 0, 1, 1);
      return J.i >= J.list.length;
    }
    baseLayer(now) {
      const d = this.o.dpr, cw = Math.round(this.W * d), ch = Math.round(this.g.mainH * d);
      const fit = (cv) => { if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } return cv; };
      const done = (J, cv) => { this.base = cv; this.baseKey = J.key; this.baseAt = J.now; this.baseTo = J.maxId; };
      if (!this.base || this.base.width !== cw || this.base.height !== ch || now < this.baseAt || now - this.baseAt > 120000) {
        const cv = fit(this.base || canvasOf()), J = this.baseStart(cv, now);   // nothing valid to show (first frame, resize, seek)
        this.baseStep(J, Infinity); done(J, cv); this.job = null;
      } else if (!this.job && (this.baseKey !== this.lkey || now - this.baseAt > 30000)) {
        this.back = fit(this.back || canvasOf()); this.job = this.baseStart(this.back, now);
      }
      if (this.job && this.baseStep(this.job, 700)) { const J = this.job, old = this.base; this.job = null; done(J, this.back); this.back = old; }
      // threads that cooled since the last build go straight onto the front layer
      const T = this.E.trades, c = this.base.getContext("2d", { alpha: false });
      c.setTransform(d, 0, 0, d, 0, 0);
      let i = T.length - 1;
      while (i >= 0 && T[i].id > this.baseTo) i--;
      for (i++; i < T.length; i++) {
        const t = T[i], age = now - t.rt; if (age < HOT) break;
        styleBucket(c, bucket(t, age), d); c.beginPath(); tracePath(c, this.geom(t, now)); c.stroke(); this.baseTo = t.id;
      }
    }
    web(ctx, now) {
      const g = this.g, E = this.E, d = this.o.dpr, T = E.trades, fresh = [];
      let i0 = T.length;
      while (i0 > 0 && now - T[i0 - 1].rt < HOT) i0--;
      // hot threads (last 12 s), oldest first so the newest lie on top; brightness = recency × size
      for (let i = i0; i < T.length; i++) {
        const t = T[i], age = now - t.rt;
        if (age < 0) continue;
        const h = Math.exp(-age / 4500), z = szN(t.usd), G = this.geom(t, now), col = t.up ? UP : DN, u = age < t._fl ? fly(age, t) : 1;
        ctx.strokeStyle = rgba(col, (0.06 + 0.56 * h) * (0.45 + 0.55 * z)); ctx.lineWidth = Math.min(1, 0.5 + 0.3 * z + 0.2 * h) / d;
        ctx.beginPath(); u < 1 ? tracePart(ctx, G, u) : tracePath(ctx, G); ctx.stroke();   // in flight the thread grows behind its spark
        if (h > 0.25 && u >= 0.5) { const r = 0.8 + (1 + 2 * z) * h; ctx.fillStyle = rgba(col, 0.85 * h); ctx.fillRect(G[6] - r / 2, G[7] - r / 2, r, r); }
        if (age < t._fl + 700) fresh.push(t);
      }
      // a new fill flies from its wallet to its market as a short tapered spark, then rings the market's edge
      for (const t of fresh) {
        const age = now - t.rt, G = t._g, z = szN(t.usd), col = t.up ? UP : DN, tint = t.up ? UPL : DNL;
        if (age < t._fl) {
          const u = fly(age, t), P = [];
          for (let k = 0; k <= 5; k++) P.push(pointAt(G, Math.max(0, u - 0.04 * (1 - k / 5))));
          const a = 0.55 + 0.45 * z, [hx, hy] = P[5], r = 1.5 + 1.8 * z;
          ctx.lineWidth = 1 / d;
          ctx.strokeStyle = rgba(col, 0.5 * a); ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]); ctx.lineTo(P[3][0], P[3][1]); ctx.stroke();
          ctx.strokeStyle = rgba(tint, 0.95 * a); ctx.beginPath(); ctx.moveTo(P[3][0], P[3][1]); ctx.lineTo(P[4][0], P[4][1]); ctx.lineTo(hx, hy); ctx.stroke();
          ctx.fillStyle = rgba(col, 0.16 * a); ctx.beginPath(); ctx.arc(hx, hy, r * 2.4, 0, TAU); ctx.fill();
          ctx.fillStyle = rgba(tint, a); ctx.fillRect(hx - r / 2, hy - r / 2, r, r);
        } else {
          const k = (age - t._fl) / 700;
          ctx.strokeStyle = rgba(col, 0.65 * (1 - k)); ctx.lineWidth = 0.8 / d;
          ctx.beginPath(); ctx.arc(G[12], G[13], 1.5 + (4 + 7 * z) * k, 0, TAU); ctx.stroke();
        }
      }
      for (const W of E.wallets.values()) {
        const age = now - W.last;
        if (age < 0 || age > E.cfg.threadAgeMs) continue;
        const h = Math.exp(-age / 4500), y = g.top + hash(W.w) * (g.bottom - g.top), x = 8 + 16 * hash(W.w, 99), r = 0.9 + 0.45 * Math.log10(1 + W.usd) + 1.6 * h;
        ctx.fillStyle = rgba(W.net >= 0 ? UP : DN, 0.3 + 0.65 * h); ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
      // top wallets: labels pushed apart so none overlap; a thin leader shows where the node really is
      const labs = this.topW.map((W, i) => ({ W, i, y: g.top + hash(W.w) * (g.bottom - g.top), x: 8 + 16 * hash(W.w, 99) })).sort((a, b) => a.y - b.y);
      labs.forEach((L, k) => { L.ly = k ? Math.max(L.y, labs[k - 1].ly + 11) : L.y; });
      for (let k = labs.length - 1; k >= 0; k--) labs[k].ly = Math.min(labs[k].ly, k === labs.length - 1 ? g.bottom : labs[k + 1].ly - 11);
      for (const { W, i, x, y, ly } of labs) {
        const s = `${i + 1} ${short(W)} ${usd(W.usd)}`, col = W.net >= 0 ? UP : DN;
        ctx.font = `8px ${MONO}`; const w = ctx.measureText(s).width;
        if (Math.abs(ly - y) > 1.5) { ctx.strokeStyle = rgba(col, 0.5); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(x + 2, y); ctx.lineTo(x + 6, ly - 2); ctx.stroke(); }
        ctx.fillStyle = "rgba(6,6,7,0.78)"; ctx.fillRect(x + 6, ly - 7, w + 6, 10);
        tx(ctx, s, x + 9, ly + 1, 8, rgba(col, 0.95));
      }
      // BTC book mid (white) and model (yellow) in the 15m and 5m windows: thin lines, a faint halo on 15m,
      // and a ripple on the head when the mid moves a tick or the model moves ≥ 1%
      for (const [tf, lw, dash] of [["5m", 0.8, [4, 3]], ["15m", 1.15, []]]) {
        const m = this.market({ a: "btc", tf, rel: 0 }, now);
        if (!m) continue;
        const f = tf === "15m", prog = (now / 1000 - m.start) / m.dur;
        const line = (pts, col, a, w) => {
          ctx.strokeStyle = rgba(col, a); ctx.lineWidth = w; ctx.setLineDash(w > 2 ? [] : dash); ctx.beginPath();
          let on = false;
          for (const [t, v] of pts) {
            if (v == null || t > now) { on = false; continue; }
            const y = g.yP(v), x = g.xW((t / 1000 - m.start) / m.dur, y);
            on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
          }
          ctx.stroke(); ctx.setLineDash([]);
        };
        if (f) { line(m.path, INK, 0.06, 4); line(m.fvPath, OURS, 0.07, 4); }
        line(m.path, INK, f ? 0.9 : 0.55, lw); line(m.fvPath, OURS, f ? 0.95 : 0.6, lw);
        ctx.strokeStyle = rgba(OURS, f ? 0.32 : 0.18); ctx.lineWidth = 0.6; ctx.setLineDash([2, 5]); ctx.beginPath();
        for (let y = g.top; y <= g.bottom; y += 6) { const x = g.xW(prog, y); y === g.top ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
        tx(ctx, `сейчас ${tf}`, g.xW(prog, g.top), g.top - (f ? 5 : -6), 8, rgba(OURS, f ? 0.8 : 0.5), "center");
        const P = this.pulse[tf] || (this.pulse[tf] = { mid: null, mt: -1e9, fv: null, ft: -1e9 }), fv = m.mod && m.mod.fv;
        if (m.mid != null && m.mid !== P.mid) { if (P.mid != null) P.mt = now; P.mid = m.mid; }
        if (fv != null && (P.fv == null || Math.abs(fv - P.fv) >= 0.01)) { if (P.fv != null) P.ft = now; P.fv = fv; }
        const head = (v, col, at) => {
          const y = g.yP(v), x = g.xW(prog, y), k = (now - at) / 800, r = f ? 3 : 2.1;
          ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = rgba(col, 1); ctx.fill();
          if (k >= 0 && k < 1) { ctx.beginPath(); ctx.arc(x, y, r + 10 * k, 0, TAU); ctx.strokeStyle = rgba(col, 0.7 * (1 - k)); ctx.lineWidth = 0.8 / d; ctx.stroke(); }
        };
        if (m.mid != null) head(m.mid, INK, P.mt);
        if (fv != null) head(fv, OURS, P.ft);
      }
    }
    kLabel(m) {
      if (m.K == null) return "неизвестна";
      const chk = m.kOk === true ? " = gamma ✓" : m.kOk === false ? " ≠ gamma ✗" : "";
      return m.kSrc === "twap" ? `twap в секунду старта${chk}` : m.kSrc === "gamma" ? "gamma priceToBeat" : `twap (сохранена)${chk}`;
    }
    gate(m, now) {
      const x = m.exe, mod = m.mod, c = this.E.cfg;
      if (m.pos) return null;
      if (!mod || mod.fv == null) return `модель выкл: ${mod ? mod.why : "нет данных"}`;
      if ((now / 1000 - m.start) / m.dur < c.minElapsed) return "ждёт 10% окна";
      if (mod.tau < c.minTau) return "τ < 30 с";
      if (!x || x.spread == null) return "нет стакана";
      if (x.spread > c.spreadMax + 1e-9) return `спред ${(x.spread * 100).toFixed(1)}¢ > 5¢`;
      return `edge < 3% (лучший ${pct(Math.max(x.eu == null ? -1 : x.eu, x.ed == null ? -1 : x.ed))})`;
    }
    posLine(P) {
      const side = P.side ? "DN" : "UP";
      if (P.pnl != null) return `paper ${side} ${P.n}@${p3(P.px)} · edge ${pct(P.edge)} · ${money(P.pnl)}${P.final ? (P.ok === false ? " ✗" : " ✓") : " ~"}`;
      return `paper ${side} ${P.n}@${p3(P.px)} · edge ${pct(P.edge)} · mo30 ${P.mo == null ? "…" : pct(P.mo)}`;
    }
    nowBox(ctx, now) {
      const g = this.g, m = this.market({ a: "btc", tf: "15m", rel: 0 }, now);
      if (!m) return;
      const mod = m.mod || {}, x = m.exe || {}, prog = (now / 1000 - m.start) / m.dur, yH = g.yP(m.mid == null ? 0.5 : m.mid), xH = g.xW(prog, yH);
      const n = x.n || m.min || 5, col = (e) => (e == null ? INK : e >= 0 ? UP : DN);
      const rows = [
        [`NOW ${mmss(now / 1000 - m.start)} / 15:00 · BTC 15m · ${clock(m.start * 1000)}–${clock(m.end * 1000)} ${TZL}`, OURS, 1],
        [`книга UP ${p3(m.bb)} / ${p3(m.ba)} · mid ${p3(m.mid)} · спред ${x.spread == null ? "—" : `${(x.spread * 100).toFixed(1)}¢`}`, INK, 0.95],
        mod.fv != null ? [`модель P(UP) ${p3(mod.fv)} · S−K ${dlt(mod.S, mod.K)} · σ60 ${sci(mod.sig)} · τ ${mmss(mod.tau)}`, OURS, 0.95]
          : [`модель выкл: ${mod.why || "нет данных"}`, OURS, 0.85],
        [`${n} ш UP ${x.up ? `${p3(x.up.px)} + fee ${p3(x.up.fee)}` : "—"} → edge ${pct(x.eu)}`, col(x.eu), 0.92],
        [`${n} ш DN ${x.dn ? `${p3(x.dn.px)} + fee ${p3(x.dn.fee)}` : "—"} → edge ${pct(x.ed)}`, col(x.ed), 0.92],
        [`K ${fp(m.K)} · ${this.kLabel(m)}`, INK, 0.6],
        [`S ${fp(mod.S)} chainlink · X ${fp(mod.X)} twap60`, INK, 0.6],
        [m.pos ? this.posLine(m.pos) : `paper: ${this.gate(m, now)}`, m.pos ? OURS : INK, m.pos ? 0.95 : 0.5],
      ];
      const bw = 352, lh = 13, bh = rows.length * lh + 10, lim = g.arcX(yH, g.R) - 30;
      let bx = xH + 18; if (bx + bw > lim) bx = xH - bw - 18; bx = Math.max(g.x0 + 4, bx);
      const by = Math.max(g.top + 60, Math.min(yH - 30, g.bottom - bh - 4));
      ctx.fillStyle = "rgba(6,6,7,0.86)"; ctx.fillRect(bx - 8, by - 13, bw, bh);
      ctx.strokeStyle = rgba(OURS, 0.4); ctx.lineWidth = 0.8; ctx.strokeRect(bx - 8, by - 13, bw, bh);
      rows.forEach(([s, c, a], i) => tx(ctx, s, bx, by + i * lh, 9.5, rgba(c, a)));
    }

    // ② ------------------------------------------------------------------------------------
    slotLines(s, now) {
      const st = this.st[s.i], L = [];
      if (s.other) {
        L.push([`прочие up/down · xau, xag, часовые · сделки ${st.n} · ${usd(st.usd)} · ${st.w.size} кош.`, INK, 0.6]);
        return L;
      }
      const m = this.market(s, now), A = s.a.toUpperCase(), d = TF[s.tf], start = Math.floor(now / 1000 / d) * d + s.rel * d;
      if (!m) { L.push([`${A} ${s.tf} · ${clock(start * 1000)} · нет данных`, INK, 0.4]); return L; }
      const mod = m.mod || {}, x = m.exe || {}, tau = m.end - now / 1000, act = m.n ? ` · посл. ${((now - m.last.rt) / 1000).toFixed(1)} с` : "";
      const flow = `сделки ${m.n} · ${usd(m.usd)} · ${m.wal.size} кош.${act}`;
      if (s.rel === -1) {
        const out = m.win != null ? m.win : m.rule, res = out == null ? "итог ожидается" : out ? "▼ DOWN" : "▲ UP";
        const off = m.win == null ? (m.rule == null ? "" : " · по twap, ждём gamma/clob") : ` · ${m.winSrc}${m.rule == null ? "" : m.rule === m.win ? " = правило ✓" : " ≠ правило ✗"}`;
        L.push([`${A} ${s.tf} · пред. ${clock(m.start * 1000)}–${clock(m.end * 1000)} · ${res}${off}`, out == null ? INK : out ? DN : UP, 0.85]);
        L.push([`K ${fp(m.K)} → twap(конец) ${fp(m.endTw)} · ${flow}`, INK, 0.5]);
        if (m.pos) L.push([this.posLine(m.pos), OURS, 0.8]);
        return L;
      }
      if (s.rel === 1) {
        L.push([`${A} ${s.tf} · след. · старт ${clock(m.start * 1000)} через ${mmss(m.start - now / 1000)} · книга ${p3(m.bb)}/${p3(m.ba)}`, INK, 0.5]);
        L.push([`до старта: ${flow}`, INK, 0.4]);
        return L;
      }
      const live = mod.fv != null;
      if (s.focus) {
        L.push([`» ${A} ${s.tf} LIVE · ${clock(m.start * 1000)}–${clock(m.end * 1000)} ${TZL} · τ ${mmss(tau)}`, OURS, 1]);
        L.push([`${m.slug} · шаг ${m.tick || "—"} · ≥${m.min} ш`, INK, 0.5]);
        L.push([`K ${fp(m.K)} · ${this.kLabel(m)}`, INK, 0.75]);
        L.push([`S ${fp(mod.S)} · X ${fp(mod.X)} · X−K ${dlt(mod.X, m.K)}`, INK, 0.75]);
        L.push([`σ60 ${sci(mod.sig)} · σ1 ${sci(mod.sig1)} · VR ${mod.vr == null ? "—" : mod.vr.toFixed(1)} · рын ${sci(mod.isig)}`, INK, 0.6]);
        L.push([`книга ${p3(m.bb)}/${p3(m.ba)} · ур. ${m.bids.size}/${m.asks.size} · изм. ${m.bookN}`, INK, 0.75]);
        L.push([`${x.n || 5} ш: UP ${x.up ? `${p3(x.up.px)}+${p3(x.up.fee)}` : "—"} · DN ${x.dn ? `${p3(x.dn.px)}+${p3(x.dn.fee)}` : "—"}`, INK, 0.75]);
        L.push(live ? [`модель ${p3(mod.fv)} · edge UP ${pct(x.eu)} · DN ${pct(x.ed)}`, OURS, 0.95] : [`модель выкл: ${mod.why || "нет данных"}`, OURS, 0.7]);
        L.push([flow, INK, 0.6]);
        L.push(m.pos ? [this.posLine(m.pos), OURS, 0.95] : [`paper: ${this.gate(m, now)}`, INK, 0.45]);
        return L;
      }
      L.push([`${A} ${s.tf} · τ ${mmss(tau)} · ${p3(m.bb)}/${p3(m.ba)}${live ? ` · модель ${p3(mod.fv)}` : ""}`, INK, 0.85]);
      L.push(live ? [`edge UP ${pct(x.eu)} · DN ${pct(x.ed)} · σ60 ${sci(mod.sig)}`, OURS, 0.75] : [`модель выкл: ${mod.why || "нет данных"}`, INK, 0.45]);
      L.push([`K ${fp(m.K)} · S−K ${dlt(mod.S, m.K)}`, INK, 0.5]);
      L.push(m.pos ? [this.posLine(m.pos), OURS, 0.85] : [flow, INK, 0.45]);
      return L;
    }
    ring(ctx, now) {
      const g = this.g, k = Math.floor(now / 250);
      if (k !== this.ringK) { this.ringK = k; this.ringBuild(now); }
      ctx.drawImage(this.ringC, this.rb.x0, 0, this.rb.w, g.mainH);
      // slot ticks: flare as a fill lands (the end of its flight)
      for (const s of this.slots) {
        const m = this.market(s, now), xo = g.arcX(s.yc, g.R), last = this.rec[s.i][0];
        let c = INK, a = 0.35;
        if (m) { const out = m.win != null ? m.win : m.rule; if (out != null) { c = out ? DN : UP; a = 0.95; } else if (s.rel === 0) { c = OURS; a = 0.9; } }
        const age = last ? now - last.rt - (last._fl || FLY) : -1, fl = age >= 0 ? Math.exp(-age / 500) : 0;
        ctx.fillStyle = rgba(c, a); ctx.fillRect(xo - 7, s.yc - 0.75, 7, 1.5);
        if (fl > 0.02) { ctx.fillStyle = rgba(last.up ? UP : DN, 0.9 * fl); ctx.fillRect(xo - 7 - 10 * fl, s.yc - 1, 7 + 10 * fl, 2); }
      }
    }
    // the ring's text changes with the 250 ms engine tick, so it is drawn once per tick into its own layer
    ringBuild(now) {
      const g = this.g, d = this.o.dpr, rb = this.rb;
      if (!this.ringC) this.ringC = canvasOf();
      const cw = Math.round(rb.w * d), ch = Math.round(g.mainH * d);
      if (this.ringC.width !== cw || this.ringC.height !== ch) { this.ringC.width = cw; this.ringC.height = ch; }
      const ctx = this.ringC.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cw, ch); ctx.setTransform(d, 0, 0, d, -rb.x0 * d, 0);
      ctx.save();
      ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(g.cx, g.cy, g.Rin, Math.PI * 1.5, Math.PI * 0.5, true); ctx.closePath();
      ctx.fillStyle = "rgba(9,9,11,0.96)"; ctx.fill(); ctx.clip();
      for (const s of this.slots) {
        ctx.strokeStyle = rgba(INK, s.focus ? 0.2 : 0.07); ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(g.arcX(s.y0, g.R), s.y0); ctx.lineTo(g.arcX(s.y0, g.Rin), s.y0); ctx.stroke();
        if (s.focus) { ctx.fillStyle = rgba(OURS, 0.03); ctx.fillRect(g.arcX(s.yc, g.R) - 40, s.y0, g.R - g.Rin + 120, s.h); }
        const lines = this.slotLines(s, now), lh = s.focus ? 9.3 : 8.1, size = s.focus ? 8.3 : 7.6;
        const n = Math.min(lines.length, Math.max(1, Math.floor((s.h - 2) / lh))), y0 = s.yc - (n * lh) / 2 + lh * 0.78;
        for (let k = 0; k < n; k++) { const [str, col, a] = lines[k], y = y0 + k * lh; tx(ctx, str, g.arcX(y, g.R) + 12, y, size, rgba(col, a)); }
      }
      ctx.restore();
      for (const [r, w, a] of [[g.R, 1.2, 0.75], [g.R - 5, 0.5, 0.3], [g.Rin, 0.8, 0.35], [g.Rin + 4, 0.5, 0.15]]) {
        ctx.beginPath(); ctx.arc(g.cx, g.cy, r, Math.PI * 0.5, Math.PI * 1.5); ctx.strokeStyle = rgba(INK, a); ctx.lineWidth = w; ctx.stroke();
      }
    }

    // ③ ------------------------------------------------------------------------------------
    rays(ctx, now) {
      for (const s of this.slots) {
        const m = this.market(s, now);
        if (s.focus && m && m.bookRt) this.bookRays(ctx, s, m, now); else this.fillRays(ctx, s, m, now);
      }
    }
    bookRays(ctx, s, m, now) {
      const g = this.g, L = this.E.levels(m), half = s.h / 2 - 4, n = Math.max(4, Math.min(26, Math.floor(half / 1.9))), lh = half / n, x = m.exe || {};
      const heat = (side, p) => { const t = m.lvl.get(side + Math.round(p * 1e4)); return t == null ? 0 : Math.exp(-(now - t) / 1400); };
      for (const [side, levels, col, dir, f] of [["a", L.asks, DN, -1, x.up], ["b", L.bids, UP, 1, x.dn]]) {
        for (let k = 0; k < Math.min(n, levels.length); k++) {
          const [p, sz] = levels[k], y = dir < 0 ? s.yc - (k + 1) * lh : s.yc + k * lh + 0.6, xs = g.arcX(y, g.Rin) + 8, h = heat(side, p);
          const len = Math.min(g.W - 16 - xs, 12 + 64 * Math.log10(1 + sz));
          ctx.fillStyle = rgba(col, 0.3 + 0.6 * h); ctx.fillRect(xs, y, len, Math.max(0.7, lh - 0.6));
          if (h > 0.04) { ctx.fillStyle = rgba(WHITE, 0.7 * h); ctx.fillRect(xs + len, y, 2.5, Math.max(0.7, lh - 0.6)); }
          const reach = f && (dir < 0 ? p <= f.worst + 1e-9 : 1 - p <= f.worst + 1e-9);
          if (reach) { ctx.fillStyle = rgba(OURS, 0.9); ctx.fillRect(xs - 5, y, 3, Math.max(0.7, lh - 0.6)); }
          if (k === 0) tx(ctx, `${side === "a" ? "ask" : "bid"} ${p3(p)} × ${sz.toFixed(0)}`, xs + len + 8, y + (dir < 0 ? 0 : lh + 6), 8.5, rgba(col, 0.95));
        }
      }
      const xm = g.arcX(s.yc, g.Rin) + 8;
      ctx.strokeStyle = rgba(INK, 0.25); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(xm, s.yc); ctx.lineTo(g.W - 16, s.yc); ctx.stroke();
      tx(ctx, `стакан UP · ${m.bids.size}/${m.asks.size} ур. · жёлтое = ${x.n || 5} ш по рынку`, g.W - 16, s.y0 + 10, 8, rgba(INK, 0.5), "right");
    }
    fillRays(ctx, s, m, now) {
      const g = this.g, list = this.rec[s.i], bh = 2.5, n = Math.min(list.length, Math.floor((s.h - 3) / bh));
      for (let k = 0; k < n; k++) {
        const t = list[k], y = s.y0 + 1.5 + k * bh, xs = g.arcX(y, g.Rin) + 8, h = Math.exp(-(now - t.rt) / 4500);
        const len = Math.min(g.W - 16 - xs, 8 + 46 * Math.log10(1 + t.usd));
        ctx.fillStyle = rgba(t.up ? UP : DN, 0.2 + 0.72 * h); ctx.fillRect(xs, y, len, bh - 0.7);
      }
      if (s.rel === -1 && m) {
        const out = m.win != null ? m.win : m.rule;
        if (out != null) tx(ctx, `${out ? "▼ DOWN" : "▲ UP"} · twap ${fp(m.endTw)} ${out ? "<" : "≥"} K ${fp(m.K)}`, g.W - 16, s.yc + 3, 8.5, rgba(out ? DN : UP, 0.9), "right");
      }
    }

    legend(ctx) {
      const x = this.g.x0 + 6, y = 17, L = LEGEND;
      if (!this.legW) {   // the backing box fits the longest line
        ctx.font = `9px ${MONO}`; const a = Math.max(ctx.measureText(L[2]).width, ctx.measureText(L[3]).width);
        ctx.font = `9.5px ${MONO}`; this.legW = Math.max(a, 178 + ctx.measureText(L[1]).width) + 16;
      }
      ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.fillRect(x - 8, y - 13, this.legW, 44);
      tx(ctx, L[0], x, y, 12, rgba(INK, 1), "left", "bold");
      tx(ctx, L[1], x + 178, y, 9.5, rgba(INK, 0.5));
      tx(ctx, L[2], x, y + 14, 9, rgba(INK, 0.72));
      tx(ctx, L[3], x, y + 27, 9, rgba(INK, 0.72));
    }

    // ④ ------------------------------------------------------------------------------------
    tiles(ctx, now) {
      const g = this.g, W = this.W, H = this.H, y0 = g.mainH, E = this.E;
      ctx.fillStyle = "#08080a"; ctx.fillRect(0, y0, W, H - y0);
      ctx.strokeStyle = rgba(INK, 0.14); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
      ["255,95,87", "254,188,46", "40,200,64"].forEach((c, i) => { ctx.beginPath(); ctx.arc(16 + i * 13, y0 + 16, 4, 0, TAU); ctx.fillStyle = rgba(c, 0.9); ctx.fill(); });
      tx(ctx, `vespera@engine ~ % live --markets crypto-updown --focus btc-15m --mode paper ${Math.floor(now / 500) % 2 ? "▍" : " "}`, 62, y0 + 20, 11.5, rgba(INK, 0.92));
      const o = this.o, mode = o.mode === "replay" ? `REPLAY · запись ${utc(o.rec.t0)}–${utc(o.rec.t1)} UTC` : o.mode === "record" ? "LIVE · REC" : "LIVE";
      tx(ctx, `${mode} · ${utc(now)} UTC · ${clock(now, true)} ${TZL}`, W - 14, y0 + 20, 10, rgba(o.mode === "replay" ? OURS : UP, 0.85), "right");
      const gap = 8, x0 = 10, ty = y0 + 32, th = H - ty - 8, tw = (W - x0 * 2 - gap * 5) / 6, X = (i) => x0 + i * (tw + gap);
      this.tFeeds(ctx, X(0), ty, tw, th, now); this.tChain(ctx, X(1), ty, tw, th, now); this.tGraph(ctx, X(2), ty, tw, th, now);
      this.tBook(ctx, X(3), ty, tw, th, now); this.tWallets(ctx, X(4), ty, tw, th, now); this.tPaper(ctx, X(5), ty, tw, th, now);
    }
    tFeeds(ctx, x, y, w, h, now) {
      const E = this.E, s0 = Math.floor(now / 1000);
      const val = (f, s) => (f && s <= f.at && f.at - s < 120 ? f.sec[((s % 120) + 120) % 120] : 0);
      const rate = (f) => { let a = 0; for (let s = s0 - 10; s < s0; s++) a += val(f, s); return a / 10; };
      const tot = Object.values(E.feeds).reduce((a, f) => a + rate(f), 0);
      tile(ctx, x, y, w, h, "feeds --live", `${tot.toFixed(0)} событий/с`, "ИСТОЧНИКИ · события/с за 60 с · задержка доставки");
      const rows = [["trades", "rtds", "rtds · сделки"], ["chainlink", "rtds", "rtds · chainlink spot"], ["twap", "rtds", "rtds · twap 60 с"], ["clob", "clob", "clob · книги"], ["gamma", "gamma", "gamma · рынки"]];
      const rh = (h - 62) / rows.length;
      rows.forEach(([k, conn, label], i) => {
        const f = E.feeds[k], st = E.conn[conn], yy = y + 46 + i * rh;
        const c = st === "open" || st === "done" ? UP : st === "connecting" || st === "reconnect" ? OURS : st ? DN : INK;
        ctx.beginPath(); ctx.arc(x + 12, yy - 3, 2.6, 0, TAU); ctx.fillStyle = rgba(c, st ? 0.95 : 0.3); ctx.fill();
        tx(ctx, label, x + 20, yy, 9.5, rgba(INK, 0.85));
        const lag = f && f.lag.length ? f.lag.slice().sort((a, b) => a - b)[f.lag.length >> 1] : null;
        const age = f && f.last ? (now - f.last) / 1000 : null;
        tx(ctx, `${f ? rate(f).toFixed(rate(f) < 10 ? 1 : 0) : "0"}/с · ${lag == null ? "—" : lag < 1000 ? `${lag.toFixed(0)} мс` : `${(lag / 1000).toFixed(1)} с`} · ${age == null ? "—" : `${age.toFixed(1)} с`}`, x + w - 10, yy, 9, rgba(INK, 0.6), "right");
        let mx = 1;
        for (let s = s0 - 60; s < s0; s++) mx = Math.max(mx, val(f, s));
        const bw = (w - 30) / 60;
        for (let j = 0; j < 60; j++) {
          const v = val(f, s0 - 60 + j); if (!v) continue;
          const hh = Math.max(1, (v / mx) * (rh - 18));
          ctx.fillStyle = rgba(j === 59 ? OURS : INK, 0.25 + 0.5 * (v / mx)); ctx.fillRect(x + 20 + j * bw, yy + 4 + (rh - 18) - hh, Math.max(1, bw - 1), hh);
        }
      });
      tx(ctx, `задержка = приём − метка источника (у сделок метка в секундах) · snap ${E.conn.snap || "—"}`, x + 10, y + h - 8, 8, rgba(INK, 0.4));
    }
    tChain(ctx, x, y, w, h, now) {
      const E = this.E, s = E.px.btc, m15 = this.market({ a: "btc", tf: "15m", rel: 0 }, now), m5 = this.market({ a: "btc", tf: "5m", rel: 0 }, now);
      tile(ctx, x, y, w, h, "chainlink --btc", "15 мин", "BTC/USD CHAINLINK · белое spot · жёлтое twap 60 с · пунктир K");
      const cx0 = x + 10, cx1 = x + w - 64, cy0 = y + 44, cy1 = y + h - 30, tA = now - 900e3;
      if (!s || s.cl.length < 2) { tx(ctx, "ждём chainlink…", cx0, cy0 + 20, 9, rgba(INK, 0.5)); return; }
      const vis = (a) => a.filter(([t]) => t >= tA && t <= now);
      const cl = vis(s.cl), tw = vis(s.tw), K15 = m15 && m15.K, K5 = m5 && m5.K;
      const vals = cl.concat(tw).map((p) => p[1]);
      let lo = Math.min(...vals), hi = Math.max(...vals);
      for (const k of [K15, K5]) if (k != null && Math.abs(k - (lo + hi) / 2) < (hi - lo) * 2 + k * 0.002) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
      const span = Math.max(hi - lo, 1e-9), X = (t) => cx0 + ((t - tA) / 900e3) * (cx1 - cx0), Y = (v) => cy1 - ((v - lo) / span) * (cy1 - cy0);
      for (let b = Math.ceil(tA / 300e3) * 300e3; b <= now; b += 300e3) {
        ctx.fillStyle = rgba(OURS, 0.07); ctx.fillRect(Math.max(cx0, X(b - 60e3)), cy0, X(b) - Math.max(cx0, X(b - 60e3)), cy1 - cy0);
        ctx.strokeStyle = rgba(INK, b % 900e3 ? 0.12 : 0.3); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(X(b), cy0); ctx.lineTo(X(b), cy1); ctx.stroke();
        tx(ctx, clock(b), X(b), cy1 + 11, 8, rgba(INK, 0.4), "center");
      }
      const poly = (a, col, lw) => { if (a.length < 2) return; ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); a.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v)))); ctx.stroke(); };
      poly(cl, rgba(INK, 0.8), 0.9); poly(tw, rgba(OURS, 0.95), 1.3);
      const kline = (m, dash) => {
        if (!m || m.K == null) return;
        ctx.setLineDash(dash); ctx.strokeStyle = rgba(OURS, 0.75); ctx.lineWidth = 0.9; ctx.beginPath();
        ctx.moveTo(Math.max(cx0, X(m.start * 1000)), Y(m.K)); ctx.lineTo(cx1, Y(m.K)); ctx.stroke(); ctx.setLineDash([]);
      };
      kline(m15, [4, 3]); kline(m5, [1, 3]);
      // K labels: one label when both windows share K (common at :00/:15/:30/:45), otherwise kept ≥ 9 px apart
      const ks = [[K15, "K15"], [K5, "K5"]].filter(([k]) => k != null);
      if (ks.length === 2 && Math.abs(K15 - K5) < 1e-9) { tx(ctx, `K ${fp(K15)}`, cx1 + 4, Y(K15) + 3, 8, rgba(OURS, 0.9)); tx(ctx, "15m = 5m", cx1 + 4, Y(K15) + 12, 7.5, rgba(OURS, 0.6)); }
      else {
        const L = ks.map(([k, lab]) => ({ y: Y(k) + 3, s: `${lab} ${fp(k)}` })).sort((a, b) => a.y - b.y);
        if (L.length === 2 && L[1].y - L[0].y < 9) { const c = (L[0].y + L[1].y) / 2; L[0].y = c - 4.5; L[1].y = c + 4.5; }
        for (const l of L) tx(ctx, l.s, cx1 + 4, l.y, 8, rgba(OURS, 0.85));
      }
      const S = s.cl[s.cl.length - 1], T = s.tw.length ? s.tw[s.tw.length - 1] : null;
      tx(ctx, `S ${fp(S[1])} · X ${fp(T && T[1])} · X−K15 ${dlt(T && T[1], K15)} · X−K5 ${dlt(T && T[1], K5)}`, x + 10, y + h - 8, 8.5, rgba(INK, 0.6));
    }
    tGraph(ctx, x, y, w, h, now) {
      const E = this.E, m = this.market({ a: "btc", tf: "15m", rel: 0 }, now), mod = (m && m.mod) || {}, ex = (m && m.exe) || {};
      tile(ctx, x, y, w, h, "model --graph", "btc 15m", "МОДЕЛЬ · нить = вклад входа в P(UP) за шаг 250 мс");
      const ix = x + 12, fx = x + w * 0.5, ox = x + w - 74, top = y + 46, gh = h - 118;
      const N = { S: [ix, top], X: [ix, top + gh * 0.2], K: [ix, top + gh * 0.4], sig: [ix, top + gh * 0.6], tau: [ix, top + gh * 0.8], book: [ix, top + gh],
        fv: [fx, top + gh * 0.45], eu: [ox, top + gh * 0.3], ed: [ox, top + gh * 0.62], paper: [ox, top + gh] };
      const routes = { S: [["S", "fv"]], X: [["X", "fv"]], K: [["K", "fv"]], sig: [["sig", "fv"]], tau: [["tau", "fv"]], book: [["book", "eu"], ["book", "ed"]], edge: [["eu", "paper"], ["ed", "paper"]] };
      ctx.save();
      for (const st of E.graph.strands) {
        const age = now - st.rt; if (age < 0 || age > 20000) continue;
        const a = Math.exp(-age / 6000) * Math.min(1, 0.18 + Math.abs(st.c) * 70), off = (hash(st.rt + st.link) - 0.5) * 22;
        for (const [p, q] of routes[st.link] || []) {
          const [x1, y1] = N[p], [x2, y2] = N[q], sx = x1 + 70, ex2 = x2 - 6;
          ctx.strokeStyle = rgba(st.c >= 0 ? UP : DN, a); ctx.lineWidth = 0.5 + Math.min(1.1, Math.abs(st.c) * 60);
          ctx.beginPath(); ctx.moveTo(sx, y1 - 3); ctx.bezierCurveTo(lerp(sx, ex2, 0.45), y1 - 3 + off, lerp(sx, ex2, 0.6), y2 - 3 - off, ex2, y2 - 3); ctx.stroke();
        }
      }
      const dv = mod.fv != null ? 0.35 : 0.08;
      for (const q of ["eu", "ed"]) { ctx.strokeStyle = rgba(OURS, dv); ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(N.fv[0] + 50, N.fv[1] - 3); ctx.lineTo(N[q][0] - 6, N[q][1] - 3); ctx.stroke(); }
      ctx.restore();
      const lab = { S: `S ${fp(mod.S)}`, X: `X ${fp(mod.X)}`, K: `K ${fp(mod.K)}`, sig: `σ60 ${sci(mod.sig)}`, tau: `τ ${mmss(mod.tau)}`, book: `книга ${p3(m && m.bb)}/${p3(m && m.ba)}` };
      for (const k in lab) tx(ctx, lab[k], N[k][0], N[k][1], 8.5, rgba(INK, 0.85));
      tx(ctx, mod.fv != null ? `P(UP) ${p3(mod.fv)}` : "P(UP) —", N.fv[0], N.fv[1], 12, rgba(OURS, mod.fv != null ? 1 : 0.5), "left", "bold");
      if (mod.fv == null) tx(ctx, mod.why || "нет данных", N.fv[0], N.fv[1] + 13, 8.5, rgba(OURS, 0.7));
      tx(ctx, `UP ${pct(ex.eu)}`, N.eu[0], N.eu[1], 9, rgba(ex.eu == null ? INK : ex.eu >= 0 ? UP : DN, 0.9));
      tx(ctx, `DN ${pct(ex.ed)}`, N.ed[0], N.ed[1], 9, rgba(ex.ed == null ? INK : ex.ed >= 0 ? UP : DN, 0.9));
      tx(ctx, `paper ${m && m.pos ? (m.pos.side ? "DN" : "UP") : "—"}`, N.paper[0], N.paper[1], 9, rgba(OURS, 0.85));
      const sx0 = x + 10, sx1 = x + w - 10, sy0 = y + h - 52, sy1 = y + h - 22, S = E.graph.sig.filter(([t]) => t > now - 900e3 && t <= now);
      const vals = S.flatMap(([, a, b]) => [a, b]).filter((v) => v != null);
      if (vals.length > 1) {
        const lo = 0, hi = Math.max(...vals) * 1.1, X = (t) => sx0 + ((t - (now - 900e3)) / 900e3) * (sx1 - sx0), Y = (v) => sy1 - ((v - lo) / (hi - lo)) * (sy1 - sy0);
        for (const [k, col] of [[1, INK], [2, OURS]]) {
          ctx.strokeStyle = rgba(col, 0.85); ctx.lineWidth = 1; ctx.beginPath(); let on = false;
          for (const p of S) { if (p[k] == null) { on = false; continue; } on ? ctx.lineTo(X(p[0]), Y(p[k])) : ctx.moveTo(X(p[0]), Y(p[k])); on = true; }
          ctx.stroke();
        }
      }
      tx(ctx, `σ60 (белое) vs σ рынка (жёлтое) · σ1 ${sci(mod.sig1)} · VR ${mod.vr == null ? "—" : mod.vr.toFixed(1)}`, x + 10, y + h - 8, 8.5, rgba(INK, 0.55));
    }
    tBook(ctx, x, y, w, h, now) {
      const m = this.market({ a: "btc", tf: "15m", rel: 0 }, now);
      tile(ctx, x, y, w, h, "book --depth", m ? `${m.bids.size}/${m.asks.size} ур.` : "—", `СТАКАН BTC 15m · UP · tick ${(m && m.tick) || "—"} · min ${(m && m.min) || "—"} ш`);
      if (!m || !m.bookRt) { tx(ctx, "ждём стакан…", x + 10, y + 60, 9, rgba(INK, 0.5)); return; }
      const L = this.E.levels(m), n = 10, gap = 14, rh = (h - 72 - gap) / (2 * n), px = x + 52, bx = px + 8, mx = Math.max(1, ...L.asks.slice(0, n).concat(L.bids.slice(0, n)).map((l) => l[1]));
      const x5 = m.exe || {};
      const row = (p, sz, side, k) => {
        const yy = side === "a" ? y + 42 + (n - 1 - k) * rh : y + 42 + (n + k) * rh + gap, t = m.lvl.get(side + Math.round(p * 1e4)), ht = t == null ? 0 : Math.exp(-(now - t) / 1400);
        const len = (Math.log10(1 + sz) / Math.log10(1 + mx)) * (w - 130), col = side === "a" ? DN : UP;
        tx(ctx, p3(p), px, yy + rh - 2, 8.5, rgba(col, 0.9), "right");
        ctx.fillStyle = rgba(col, 0.25 + 0.6 * ht); ctx.fillRect(bx, yy + 1, len, rh - 2);
        tx(ctx, sz >= 1000 ? `${(sz / 1000).toFixed(1)}k` : sz.toFixed(0), bx + len + 5, yy + rh - 2, 8, rgba(INK, 0.55 + 0.4 * ht));
        const f = side === "a" ? x5.up : x5.dn;
        if (f && (side === "a" ? p <= f.worst + 1e-9 : 1 - p <= f.worst + 1e-9)) { ctx.fillStyle = rgba(OURS, 0.9); ctx.fillRect(bx - 5, yy + 1, 3, rh - 2); }
      };
      L.asks.slice(0, n).forEach(([p, s], k) => row(p, s, "a", k));
      L.bids.slice(0, n).forEach(([p, s], k) => row(p, s, "b", k));
      // mid and spread sit in their own gap between asks and bids, so they never cover a size label
      const ym = y + 42 + n * rh + gap / 2, ms = `mid ${p3(m.mid)} · спред ${x5.spread == null ? "—" : `${(x5.spread * 100).toFixed(1)}¢`}`;
      ctx.font = `8.5px ${MONO}`; const mw = ctx.measureText(ms).width;
      ctx.strokeStyle = rgba(INK, 0.3); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(x + 10, ym); ctx.lineTo(x + w - 18 - mw, ym); ctx.stroke();
      tx(ctx, ms, x + w - 10, ym + 3, 8.5, rgba(INK, 0.75), "right");
      tx(ctx, `изменений ${m.bookN} · последнее ${((now - m.bookRt) / 1000).toFixed(1)} с назад · жёлтое = ${x5.n || 5} ш`, x + 10, y + h - 8, 8.5, rgba(INK, 0.5));
    }
    tWallets(ctx, x, y, w, h, now) {
      const E = this.E;
      tile(ctx, x, y, w, h, "wallets --top", `${E.wallets.size} кош.`, "КОШЕЛЬКИ · объём за сессию · чистая позиция UP/DOWN");
      const rh = (h - 62) / 8, cx = x + w - 62;
      this.topW.forEach((W, i) => {
        const yy = y + 50 + i * rh, ht = Math.exp(-(now - W.last) / 4500);
        tx(ctx, `${i + 1} ${short(W)}`, x + 10, yy, 9, rgba(INK, 0.6 + 0.4 * ht));
        tx(ctx, `${usd(W.usd)} · ${W.n}×`, cx - 48, yy, 8.5, rgba(INK, 0.6), "right");
        const f = Math.max(-1, Math.min(1, W.net / Math.max(W.usd, 1e-9)));
        ctx.fillStyle = rgba(INK, 0.12); ctx.fillRect(cx - 40, yy - 6, 80, 6);
        ctx.fillStyle = rgba(f >= 0 ? UP : DN, 0.5 + 0.5 * ht); ctx.fillRect(f >= 0 ? cx : cx + 40 * f, yy - 6, 40 * Math.abs(f), 6);
        tx(ctx, `${((now - W.last) / 1000).toFixed(0)} с`, x + w - 10, yy, 8, rgba(INK, 0.45), "right");
      });
      let fills = 0; for (let i = E.trades.length - 1; i >= 0 && now - E.trades[i].rt < 60000; i--) if (E.trades[i].rt <= now) fills++;
      tx(ctx, `сделок за минуту ${fills} · полоса: доля на UP (вправо) / DOWN (влево)`, x + 10, y + h - 8, 8.5, rgba(INK, 0.45));
    }
    tPaper(ctx, x, y, w, h, now) {
      const E = this.E, S = E.stats(), take = C.take;
      tile(ctx, x, y, w, h, "paper --v2", `${S.n} входов`, "PAPER · реальный стакан · 5 ш · комиссия 0.07·p(1−p)");
      // open positions marked at what the live book would pay right now (sell 5 sh into the bids, taker fee included)
      let mtm = 0, nm = 0;
      for (const P of E.paper) {
        if (P.pnl != null) continue;
        const m = E.mk.get(P.slug); if (!m || !m.bookRt) continue;
        const L = E.levels(m), f = P.side === 0 ? take(L.bids, P.n, m.fee, m.fexp, false) : take(L.asks, P.n, m.fee, m.fexp, true);
        if (f) { mtm += P.n * (f.px - f.fee - P.px - P.fee); nm++; }
      }
      tx(ctx, S.done ? money(S.pnl) : "—", x + 10, y + 70, 28, rgba(S.done ? (S.pnl < 0 ? DN : UP) : INK, S.done ? 1 : 0.45), "left", "bold");
      tx(ctx, S.done ? `итог ${S.done} окон по правилу/результату` : "итогов ещё нет: окна не закрылись", x + (S.done ? 150 : 40), y + 66, 8.5, rgba(INK, 0.5));
      tx(ctx, `закрыто ${S.done} · плюс ${S.wins}/${S.done} · открыто ${S.open} · расхождений ${S.bad}`, x + 10, y + 88, 8.5, rgba(INK, 0.6));
      tx(ctx, `открытые, если продать сейчас: ${nm ? money(mtm) : "—"}${nm ? ` (${nm})` : ""}`, x + 10, y + 101, 8.5, rgba(nm ? (mtm < 0 ? DN : UP) : INK, nm ? 0.85 : 0.5));
      tx(ctx, `средний edge ${pct(S.edge)} · markout 30 с ${pct(S.mo)}`, x + 10, y + 114, 8.5, rgba(INK, 0.6));
      const list = E.paper.slice(-7).reverse();
      if (!list.length) tx(ctx, "входов пока нет: ждём edge ≥ 3% после комиссии", x + 10, y + 134, 8.5, rgba(OURS, 0.7));
      list.forEach((P, i) => {
        const yy = y + 133 + i * 12, res = P.pnl != null ? `${money(P.pnl)}${P.final ? (P.ok === false ? "✗" : "✓") : "~"}` : P.mo != null ? `mo30 ${pct(P.mo)}` : "открыт";
        tx(ctx, `${clock(P.rt)} ${P.asset} ${P.tf} ${P.side ? "DN" : "UP"} ${P.n}@${p3(P.px)} fv ${p3(P.fv)} ${pct(P.edge)} ${res}`, x + 10, yy, 8.3,
          rgba(P.pnl != null ? (P.pnl >= 0 ? UP : DN) : INK, P.pnl != null ? 0.9 : 0.7));
      });
      tx(ctx, "вход: edge ≥ 3% · ≥10% окна · τ ≥ 30 с · спред ≤ 5¢ · 1 на окно", x + 10, y + h - 20, 8, rgba(INK, 0.4));
      tx(ctx, "итог: twap(конец) ≥ K, сверка с gamma/clob · без ордеров", x + 10, y + h - 8, 8, rgba(INK, 0.4));
    }
  }

  const mount = (canvas, eng, opts) => new Renderer(canvas, eng, opts);
  global.VesperaRender = { mount, Renderer, geometry, SLOTS };
})(typeof window !== "undefined" ? window : globalThis);
