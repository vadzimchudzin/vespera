/* Vespera Engine Live — renderer. Canvas 2D, no dependencies; draws an Engine (core.js) at a given time.
 *  ① trade web: each fill on any Polymarket market is one thread: wallet (left edge) → bend at (time to its event's
 *     end, price of outcome 0) → its event on the ring. Teal = exposure to outcome 0 (YES / UP / the first team),
 *     orange = to outcome 1. A new fill flies there as a spark; the thread cools over ~12 s into the trace.
 *  ② ring: every open event (crypto Up/Down series collapsed; BTC with its previous, live and next windows), by sector.
 *     Only a fragment is visible: drag it with the left button (it keeps spinning and settles on a slot), the wheel
 *     scrolls, Ctrl+wheel zooms. Slots near the focus line swell; the rest of the ring is squeezed into the two ends of
 *     the arc, so a thread to a hidden market still flies to the side where its market is.
 *  ③ rays: the book of the market in focus (BTC: the engine's books), level by level; other slots: their last fills.
 *  ④ tiles: feeds, Chainlink, model graph, book, wallets, paper test (the crypto engine).
 *  Files: render.js — frame, input and ring motion, ① web and its layers; ring.js — ②, ③, the focus card, minimap,
 *  sector list, "now" box and legend; tiles.js — ④. ring.js and tiles.js add their methods to Renderer. */
(function (global) {
  "use strict";
  const MONO = '"JetBrains Mono","DejaVu Sans Mono","Liberation Mono",monospace';
  const INK = "235,235,228", UP = "57,214,176", DN = "255,106,61", OURS = "255,211,77", WHITE = "255,255,255";
  const UPL = "190,250,232", DNL = "255,214,190";   // light tints of UP and DN for sparks
  const TZ = "Etc/GMT-3", TZL = "UTC+3", HOT = 12000, TF = { "5m": 300, "15m": 900 }, TAU = Math.PI * 2;
  const C = global.VesperaCore, UV = global.VesperaUniverse, fp = C.fmtPx;
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
  // Polymarket style: 23¢, 99.9¢, 0.4¢
  const cents = (p) => { if (p == null || !isFinite(p)) return "—"; const c = p * 100; return c >= 1 && c <= 99 ? `${Math.round(c)}¢` : `${c.toFixed(1)}¢`; };
  const dur = (s) => (s < 90 ? `${Math.round(s)} с` : s < 5400 ? `${Math.round(s / 60)} мин` : s < 129600 ? `${Math.round(s / 3600)} ч` : s < 45 * 86400 ? `${Math.round(s / 86400)} д` : s < 548 * 86400 ? `${Math.round(s / 2629800)} мес` : `${(s / 31557600).toFixed(1)} г`);
  const ago = (now, rt) => { const s = (now - rt) / 1000; return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} с` : `${Math.floor(s / 60)} мин`; };
  const nf = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  // monospace: a character is 0.6 em wide, so a line is cut by length, no measureText
  const fitc = (s, px, size) => { const n = Math.max(4, Math.floor(px / (size * 0.6))); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  function hash(s, seed = 2166136261) {
    let h = seed >>> 0; s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function erf(x) {   // Abramowitz–Stegun 7.1.26
    const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x < 0 ? -y : y;
  }
  function tx(ctx, s, x, y, size, color, align = "left", weight = "") {
    ctx.font = `${weight ? weight + " " : ""}${size}px ${MONO}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y);
  }
  function tracePath(c, G) { c.moveTo(G[0], G[1]); c.bezierCurveTo(G[2], G[3], G[4], G[5], G[6], G[7]); c.bezierCurveTo(G[8], G[9], G[10], G[11], G[12], G[13]); }
  const traceA = (c, G) => { c.moveTo(G[0], G[1]); c.bezierCurveTo(G[2], G[3], G[4], G[5], G[6], G[7]); };
  const traceB = (c, G) => { c.moveTo(G[6], G[7]); c.bezierCurveTo(G[8], G[9], G[10], G[11], G[12], G[13]); };
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
    "все рынки Polymarket вживую: rtds сделки, clob стаканы, gamma каталог — без прокси и симуляций",
    "① нить = сделка: кошелёк → (время до итога, цена YES/UP) → событие на кольце · бирюза = YES/UP, оранж = NO/DOWN · яркость = $",
    "② кольцо: все открытые события · ЛКМ — крутить · колесо — листать · Ctrl+колесо — масштаб · клик — фокус · ③ стакан фокуса"];

  // The ring is a tape of slots (20 px × weight at zoom 1) bent along the arc. P = tape coordinate at the focus line.
  // A fisheye swells the slots near the focus (FK = extra px, FS = its width); past the visible window the tape is
  // squeezed into PORT px at each end of the arc.
  const FS = 16, FK = 4.5 * FS * Math.sqrt(Math.PI) / 2, PORT = 18, ZMIN = 0.35, ZMAX = 1.8;
  const LOGT = Math.log10((2 * 365.25 * 86400) / 900);
  const TICKS = [[0, "итог"], [300, "5:00"], [600, "10:00"], [900, "15:00"], [3600, "1 ч"], [21600, "6 ч"], [86400, "1 д"], [604800, "1 нед"],
    [2592000, "1 мес"], [15778800, "6 мес"], [31557600, "1 год"], [63115200, "2 года"]];

  function geometry(W, H) {
    const mainH = Math.round(H * 0.735), R = W * 0.62, cx = W * 0.47 + R, cy = Math.round(mainH * 0.47), band = W * 0.122;
    const arcX = (y, r) => cx - Math.sqrt(Math.max(r * r - (y - cy) ** 2, 0));
    const g = { W, H, mainH, R, Rin: R - band, cx, cy, arcX, top: 64, bottom: mainH - 30, x0: 64, yF: cy, vt: 6 + PORT, vb: mainH - 6 - PORT };
    g.yP = (p) => g.top + 8 + (1 - p) * (g.bottom - g.top - 16);
    // time to the event's end: the last 15 minutes are linear (the crypto windows), longer times logarithmic to 2 years
    g.xT = (tau, y) => {
      const xr = arcX(y, R) - 24, xk = g.x0 + 0.44 * (xr - g.x0);
      if (tau == null) return g.x0;
      const t = Math.max(0, tau);
      if (t <= 900) return xr - (t / 900) * (xr - xk);
      return Math.max(g.x0, xk - (Math.log10(t / 900) / LOGT) * (xk - g.x0));
    };
    g.band = band;
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
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

  class Renderer {
    constructor(canvas, eng, opts = {}) {
      this.c = canvas; this.ctx = canvas.getContext("2d"); this.E = eng; this.U = eng.uni;
      this.o = Object.assign({ dpr: 1, mode: "live" }, opts);
      this.topW = []; this.topAt = -Infinity; this.pulse = {}; this.tileK = null; this.legW = 0;
      this.A = null; this.B = null; this.backA = null; this.backB = null; this.job = null; this.tiny = null; this.ringC = null;
      this.ui = { P: 0, z: 1, zt: 1, v: 0, anim: null, drag: null, last: 0, restAt: -1e9, anchor: null, lv: -1, snapAt: null };
      this.focusS = null; this.bookS = null; this.bookAt = 0; this.bookFor = null; this.fTok = null; this.vis = []; this.rkey = "";
      this.portal = [0, 0]; this.rec = new Map(); this.recAt = -Infinity; this.moving = false;
      this.resize();
      if (canvas.addEventListener && !this.o.noInput) this.bind();
    }
    resize() {
      const W = this.o.width || global.innerWidth, H = this.o.height || global.innerHeight, d = this.o.dpr;
      this.W = W; this.H = H; this.c.width = Math.round(W * d); this.c.height = Math.round(H * d);
      if (this.c.style) { this.c.style.width = `${W}px`; this.c.style.height = `${H}px`; }
      this.g = geometry(W, H); this.akey = `${W}x${H}`;
      const g = this.g, x0 = Math.floor(g.cx - g.R - 4), x1 = Math.min(W, Math.ceil(Math.max(g.arcX(0, g.Rin), g.arcX(g.mainH, g.Rin)) + 4));
      this.rb = { x0, w: x1 - x0 };
      this.mm = { cx: W - 66, cy: 70, r: 44 }; this.sl = { x: W - 66 - 44 - 26 - 176, y: 14, w: 176, rh: 11 };
      this.aAt = -1e9; this.bKey = null; this.job = null; this.ringK = null; this.tileK = null; this.legW = 0; this.A = null;
    }

    // ---- input: drag to spin (with inertia), wheel to scroll, Ctrl+wheel to zoom, click to focus -------------------------
    bind() {
      const c = this.c, pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      if (c.style) { c.style.touchAction = "none"; c.style.cursor = "grab"; }
      c.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; const [x, y] = pos(e); if (this.pointer("down", x, y, e.timeStamp)) { try { c.setPointerCapture(e.pointerId); } catch (err) {} e.preventDefault(); } });
      c.addEventListener("pointermove", (e) => { const [x, y] = pos(e); this.pointer("move", x, y, e.timeStamp); });
      const up = (e) => { const [x, y] = pos(e); this.pointer("up", x, y, e.timeStamp); };
      c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
      c.addEventListener("wheel", (e) => {
        const [, y] = pos(e); if (y > this.g.mainH) return;
        e.preventDefault(); this.wheel(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1), e.ctrlKey || e.metaKey);
      }, { passive: false });
      if (global.addEventListener) global.addEventListener("keydown", (e) => { if (!e.altKey && this.key(e.key)) e.preventDefault(); });
    }
    pointer(type, x, y, t) {
      const u = this.ui, g = this.g;
      if (type === "down") {
        if (y > g.mainH) return false;
        u.drag = { x, y, cg: u.P + this.iy(y), moved: 0, s: [[t, u.P]] }; u.anim = null; u.v = 0; u.snapAt = null;
        if (this.c.style) this.c.style.cursor = "grabbing";
        return true;
      }
      const D = u.drag;
      if (type === "move") {
        if (!D) { if (this.c.style) this.c.style.cursor = y > g.mainH ? "default" : this.hitUI(x, y) ? "pointer" : "grab"; return false; }
        D.moved = Math.max(D.moved, Math.abs(y - D.y) + Math.abs(x - D.x));
        if (D.moved < 4) return true;
        u.P = D.cg - this.iy(y); D.s.push([t, u.P]);
        while (D.s.length > 2 && t - D.s[0][0] > 90) D.s.shift();
        return true;
      }
      if (!D) return false;
      u.drag = null;
      if (this.c.style) this.c.style.cursor = "grab";
      if (D.moved < 4) { this.click(x, y); return true; }
      const a = D.s[0], b = D.s[D.s.length - 1], dt = (b[0] - a[0]) / 1000;
      u.v = dt > 0.008 && t - b[0] < 90 ? Math.max(-80000, Math.min(80000, (b[1] - a[1]) / dt)) : 0;
      if (!u.v) u.snapAt = u.last;
      return true;
    }
    hitUI(x, y) { const m = this.mm; return (x - m.cx) ** 2 + (y - m.cy) ** 2 <= (m.r + 12) ** 2 || !!this.secHit(x, y); }
    secHit(x, y) {
      const L = this.sl;
      if (x < L.x - 4 || x > L.x + L.w || y < L.y - 9) return null;
      const k = Math.floor((y - L.y + 9) / L.rh), S = this.U.sec.filter((s) => s.n);
      return S[k] || null;
    }
    click(x, y) {
      const g = this.g, m = this.mm;
      if ((x - m.cx) ** 2 + (y - m.cy) ** 2 <= (m.r + 12) ** 2) {
        const a = (((Math.atan2(y - m.cy, x - m.cx) + Math.PI / 2) / TAU) % 1 + 1) % 1, s = this.U.at(a * this.U.len);
        if (s) this.gotoSlot(s);
        return;
      }
      const S = this.secHit(x, y);
      if (S) { this.gotoSector(S); return; }
      if (x > g.arcX(y, g.R) - 30) { const s = this.U.at(this.ui.P + this.iy(y)); if (s) this.gotoSlot(s); }
    }
    goto(c, ms, slot) {
      const u = this.ui, L = this.U.len || 1;
      let d = c - u.P; d = (((d + L / 2) % L) + L) % L - L / 2;
      const dist = Math.abs(d) * u.z;
      u.anim = { from: u.P, to: u.P + d, t0: u.last, dur: ms || Math.min(1700, 280 + 170 * Math.log2(1 + dist / 300)), slot }; u.v = 0; u.snapAt = null;
    }
    gotoSlot(s) { if (s) this.goto(s.c + s.h / 2, null, s); }
    gotoSector(S) { this.gotoSlot(this.U.ring[S.i0]); }
    home() { this.gotoSlot(this.U.slots.get("eng:btc:15m:0")); }
    fling(v) { this.ui.anim = null; this.ui.v = v; this.ui.snapAt = null; }
    zoomTo(z) { this.ui.zt = Math.max(ZMIN, Math.min(ZMAX, z)); }
    wheel(dy, zoom) {
      const u = this.ui;
      if (zoom) { this.zoomTo(u.zt * Math.exp(-dy * 0.0022)); return; }
      const to = (u.anim && !u.anim.snap ? u.anim.to : u.P) + (dy * 0.8) / u.z;
      u.anim = { from: u.P, to, t0: u.last, dur: 230, wheel: true }; u.v = 0; u.snapAt = null;
    }
    key(k) {
      const R = this.U.ring, n = R.length, f = this.focusS, step = { ArrowDown: 1, ArrowUp: -1, PageDown: 12, PageUp: -12 }[k];
      if (step && f && n) { this.gotoSlot(R[(((f.i + step) % n) + n) % n]); return true; }
      if (k === "Home") { this.home(); return true; }
      if (k === "+" || k === "=") { this.zoomTo(this.ui.zt * 1.25); return true; }
      if (k === "-" || k === "_") { this.zoomTo(this.ui.zt / 1.25); return true; }
      if (k === "0") { this.zoomTo(1); return true; }
      return false;
    }
    // the ring's clock runs on the frame time, so a replay captured frame by frame spins the same way every time
    stepUI(now) {
      const u = this.ui, U = this.U, dt = Math.max(0, Math.min(0.05, (now - u.last) / 1000));
      u.last = now;
      if (U.layout(now) || u.lv !== U.v) {   // the order changed: keep the slot in focus where it is
        const A = u.anchor, h = U.slots.get("eng:btc:15m:0");
        const np = A && A.s.sec === A.sec && U.slots.get(A.s.key) === A.s ? A.s.c + A.off : u.lv < 0 && h ? h.c + h.h / 2 : u.P, sh = np - u.P;
        u.P = np; if (u.drag) u.drag.cg += sh; if (u.anim) { u.anim.from += sh; u.anim.to += sh; }
        const T = u.anim && u.anim.slot;   // a jump to a slot follows that slot to its new place
        if (T && U.slots.get(T.key) === T) { const L = U.len || 1; let d = T.c + T.h / 2 - u.anim.to; d = (((d + L / 2) % L) + L) % L - L / 2; u.anim.to += d; }
        u.lv = U.v;
      }
      if (u.z !== u.zt) { u.z += (u.zt - u.z) * Math.min(1, dt * 14); if (Math.abs(u.zt - u.z) < 1e-3) u.z = u.zt; }
      let moving = !!u.drag;
      if (!u.drag && u.anim) {
        const A = u.anim, k = Math.max(0, Math.min(1, (now - A.t0) / A.dur));
        u.P = A.from + (A.to - A.from) * (A.wheel ? 1 - (1 - k) ** 3 : ease(k)); moving = true;
        if (k >= 1) { u.anim = null; if (!A.snap) u.snapAt = now + (A.wheel ? 220 : 0); }
      } else if (!u.drag && u.v) {
        u.P += u.v * dt; u.v *= Math.exp(-dt / 0.6); moving = true;
        if (Math.abs(u.v) * u.z < 50) { u.v = 0; u.snapAt = now; }
      }
      if (!u.drag && !u.anim && !u.v && u.snapAt != null && now >= u.snapAt) {   // settle on the slot in focus
        u.snapAt = null;
        const s = U.at(u.P);
        if (s) { const L = U.len; let d = s.c + s.h / 2 - u.P; d = (((d + L / 2) % L) + L) % L - L / 2; if (Math.abs(d) > 0.05) { u.anim = { from: u.P, to: u.P + d, t0: now, dur: 240, snap: true }; moving = true; } }
      }
      const L = U.len || 1;
      if (u.P < 0 || u.P >= L) { const np = ((u.P % L) + L) % L, sh = np - u.P; u.P = np; if (u.drag) u.drag.cg += sh; if (u.anim) { u.anim.from += sh; u.anim.to += sh; } }
      if (moving || u.z !== u.zt) u.restAt = now;
      const f = U.at(u.P);
      if (f) u.anchor = { s: f, off: u.P - f.c, sec: f.sec };
      this.focusS = f;
      this.moving = now - u.restAt < 120 && now >= u.restAt;
      this.rkey = `${U.v}|${u.P.toFixed(2)}|${u.z.toFixed(4)}|${this.akey}|${Math.floor(now / 300000)}`;
    }
    // screen y of a tape offset d (tape px from the focus line), and back
    ry(d) {
      const g = this.g, x = d * this.ui.z, y = g.yF + x + FK * erf(x / FS);
      if (y < g.vt) return g.vt - PORT * (1 - Math.exp((y - g.vt) / 900));
      if (y > g.vb) return g.vb + PORT * (1 - Math.exp((g.vb - y) / 900));
      return y;
    }
    iy(y) {
      const L = (this.U.len || 1) / 2;
      let lo = -L, hi = L;
      if (y <= this.ry(lo)) return lo;
      if (y >= this.ry(hi)) return hi;
      for (let k = 0; k < 48; k++) { const m = (lo + hi) / 2; if (this.ry(m) < y) lo = m; else hi = m; }
      return (lo + hi) / 2;
    }
    wrapD(c) { const L = this.U.len || 1; const d = c - this.ui.P; return (((d + L / 2) % L) + L) % L - L / 2; }
    place(s) {
      if (s._pk === this.rkey) return s._pl;
      const d0 = this.wrapD(s.c), y0 = this.ry(d0), y1 = this.ry(d0 + s.h), p = s._pl || (s._pl = {});
      p.y0 = y0; p.y1 = y1; p.yc = (y0 + y1) / 2; p.h = y1 - y0; s._pk = this.rkey;
      return p;
    }
    visibleSlots() {
      const R = this.U.ring, n = R.length, g = this.g, out = this.vis, f = this.focusS;
      out.length = 0;
      if (!f || !n) return out;
      const up = [];
      let k = 1;
      for (let i = (f.i - 1 + n) % n; k < n; k++, i = (i - 1 + n) % n) { const s = R[i]; if (this.place(s).y1 <= g.vt) break; up.push(s); }
      for (let j = up.length - 1; j >= 0; j--) out.push(up[j]);
      this.place(f); out.push(f);
      for (let i = (f.i + 1) % n; k < n; k++, i = (i + 1) % n) { const s = R[i]; if (this.place(s).y0 >= g.vb) break; out.push(s); }
      return out;
    }
    // the slot a thread lands on: BTC fills by window (previous, live, next), everything else by its event or series
    slotOf(T, now) {
      if (T.a === "btc" && TF[T.tf]) { const d = TF[T.tf], cur = Math.floor(now / 1000 / d) * d; return this.U.slots.get(`eng:btc:${T.tf}:${Math.max(-1, Math.min(1, Math.round((T.st - cur) / d)))}`); }
      return T.s;
    }
    market(s, now) {   // the engine's market for an engine slot (or {a, tf, rel})
      if (!s || !TF[s.tf] || s.rel == null) return null;
      const d = TF[s.tf], st = Math.floor(now / 1000 / d) * d + s.rel * d;
      return this.E.mk.get(`${s.a}-updown-${s.tf}-${st}`) || null;
    }
    tauOf(T) {
      if (T.end != null) return T.end - T.ts;
      const s = T.s;
      if (!s) return null;
      const e = s.kind === "ser" ? s.ends && s.ends.get(T.ev) : s.end;
      return e == null ? null : e - T.ts;
    }
    // wallet → bend: depends on the canvas size only, so it is cached for good
    partA(T) {
      if (T._ak === this.akey && (T._at != null || this.tauOf(T) == null)) return T._a;
      const g = this.g, wx = 8 + 16 * hash(T.w, 99), wy = g.top + hash(T.w) * (g.bottom - g.top), by = g.yP(T.p), tau = this.tauOf(T), bx = g.xT(tau, by);
      T._a = [wx, wy, lerp(wx, bx, 0.55), wy, lerp(bx, wx, 0.25), by, bx, by]; T._ak = this.akey; T._at = tau;
      return T._a;
    }
    geom(T, now) {
      const A = this.partA(T);
      if (T._k === this.rkey && T._ka === A) return T._g;
      const g = this.g, s = this.slotOf(T, now);
      if (!s) return null;   // a fill whose market is not known yet (its token is being looked up)
      const G = T._g || (T._g = new Array(14));
      for (let k = 0; k < 8; k++) G[k] = A[k];
      const bx = A[6], by = A[7];
      const p = this.place(s), ry = p.yc + (T.up ? -1 : 1) * p.h * (0.06 + 0.34 * hash(T.id, 7));
      const rx = g.arcX(ry, g.R) + 1;
      G[8] = lerp(bx, rx, 0.4); G[9] = by; G[10] = lerp(rx, bx, 0.3); G[11] = ry; G[12] = rx; G[13] = ry;
      if (T._fl == null) T._fl = Math.min(FLY, Math.max(600, (Math.hypot(bx - A[0], by - A[1]) + Math.hypot(rx - bx, ry - by)) / 1.3));
      T._k = this.rkey; T._ka = A;
      return G;
    }
    recent(now) {   // newest fills per slot, at most 48 each, from the last 3 minutes
      const out = new Map(), T = this.E.trades;
      for (let i = T.length - 1, k = 0; i >= 0 && k < 6000; i--, k++) {
        const t = T[i]; if (t.rt > now) continue; if (now - t.rt > 180e3) break;
        const s = this.slotOf(t, now); if (!s) continue;
        let a = out.get(s); if (!a) out.set(s, (a = []));
        if (a.length < 48) a.push(t);
      }
      return out;
    }
    // the market in focus: its details are fetched, and its book (outcome-0 token) is watched once it stays 0.3 s
    focusWork(now) {
      const U = this.U, f = this.focusS;
      if (!f) return;
      if (!this.moving) for (const s of this.vis) if (s.kind === "ev" && !s.det && s._pl.h >= 6.5) U.want(s);
      if (f !== this.bookS) { this.bookS = f; this.bookAt = now; }
      if (now - this.bookAt < 300 && now >= this.bookAt) return;
      const m = f.kind === "ev" ? U.leads(f)[0] : null, tok = m && m.tk[0] ? m.tk[0] : null;
      if (this.bookFor !== f || this.fTok !== tok) { this.bookFor = f; this.fTok = tok; U.watch(tok ? [tok] : []); }
    }

    draw(now) {
      const ctx = this.ctx, g = this.g, d = this.o.dpr;
      this.stepUI(now); this.visibleSlots(); this.focusWork(now);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      if (now - this.topAt > 1000 || now < this.topAt) { this.topW = [...this.E.wallets.values()].sort((a, b) => b.usd - a.usd).slice(0, 8); this.topAt = now; }
      if (now - this.recAt > 250 || now < this.recAt) { this.rec = this.recent(now); this.recAt = now; }
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.W, g.mainH); ctx.clip();
      this.layers(now);
      const useB = this.B && this.bKey === this.rkey;
      ctx.drawImage(useB ? this.B : this.A, 0, 0, this.W, g.mainH);
      if (!useB) this.transientB(ctx, now);
      this.web(ctx, now); this.btcLines(ctx, now); this.rays(ctx, now); this.ring(ctx, now); this.portals(ctx); this.minimap(ctx, now);
      this.nowBox(ctx, now); this.card(ctx, now);
      this.legend(ctx);
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
        tx(c, p === 1 ? "YES/UP 1.00" : p === 0 ? "NO/DOWN 0" : p.toFixed(2).replace(/^0/, ""), g.x0 + 3, y - 3, 8.5, rgba(INK, 0.42));
      }
      c.setLineDash([]);
      const curve = (tau, a) => { c.strokeStyle = rgba(INK, a); c.beginPath(); for (let y = g.top; y <= g.bottom; y += 8) { const x = g.xT(tau, y); y === g.top ? c.moveTo(x, y) : c.lineTo(x, y); } c.stroke(); };
      for (let m = 1; m < 15; m++) if (m % 5) curve(m * 60, 0.03);
      for (const [tau, lab] of TICKS) { curve(tau, tau === 900 ? 0.13 : 0.075); tx(c, lab, g.xT(tau, g.bottom), g.bottom + 14, 8.5, rgba(INK, tau === 900 ? 0.5 : 0.38), "center"); }
      tx(c, "← время до итога: годы, месяцы, дни · последние 15 минут — окна крипто 15m и 5m →", g.xT(0, g.bottom) - 4, g.bottom + 25, 8, rgba(INK, 0.3), "right");
    }
    // Layer A: background, grid and the wallet → bend half of every cooled thread; it does not move with the ring.
    // Layer B: A plus the bend → ring halves for one ring position. While the ring moves the frame shows A plus the ring
    // halves of the newest cooled threads; when it rests, B is rebuilt in a back buffer, 1500 halves a frame. Both are
    // rebuilt every 30 s as the trace ages.
    newJob(kind, cv, now) {
      const d = this.o.dpr, c = cv.getContext("2d", { alpha: false }), list = [], lim = kind === "A" ? Infinity : this.aTo;
      if (kind === "A") { c.setTransform(d, 0, 0, d, 0, 0); c.fillStyle = "#060607"; c.fillRect(0, 0, this.W, this.g.mainH); this.grid(c); }
      else { c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(this.A, 0, 0); }
      for (const t of this.E.trades) { if (now - t.rt < HOT || t.id > lim) break; list.push(t); }
      return { kind, c, cv, now, list, i: 0, key: this.rkey, maxId: list.length ? list[list.length - 1].id : kind === "A" ? 0 : this.aTo };
    }
    step(J, n, now) {
      const d = this.o.dpr, groups = new Map(), end = Math.min(J.list.length, J.i + n), A = J.kind === "A";
      for (; J.i < end; J.i++) { const t = J.list[J.i], b = bucket(t, J.now - t.rt); let a = groups.get(b); if (!a) groups.set(b, (a = [])); a.push(t); }
      J.c.setTransform(d, 0, 0, d, 0, 0);
      for (const [b, arr] of groups) { styleBucket(J.c, b, d); J.c.beginPath(); for (const t of arr) { if (A) traceA(J.c, this.partA(t)); else { const G = this.geom(t, now); if (G) traceB(J.c, G); } } J.c.stroke(); }
      // canvas 2D records and rasterises lazily: copying one pixel out makes this chunk rasterise now, not all at the swap
      if (n !== Infinity) (this.tiny || (this.tiny = canvasOf())).getContext("2d").drawImage(J.c.canvas, 0, 0, 1, 1, 0, 0, 1, 1);
      return J.i >= J.list.length;
    }
    layers(now) {
      const d = this.o.dpr, cw = Math.round(this.W * d), ch = Math.round(this.g.mainH * d), T = this.E.trades;
      const fit = (cv) => { cv = cv || canvasOf(); if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } return cv; };
      const catchUp = (c, from, to, full) => {   // threads that cooled while a layer was being built
        let i = T.length - 1;
        while (i >= 0 && T[i].id > from) i--;
        let last = from;
        for (i++; i < T.length; i++) {
          const t = T[i]; if (t.id > to || now - t.rt < HOT) break;
          const G = full ? this.geom(t, now) : null;
          if (!full || G) { styleBucket(c, bucket(t, now - t.rt), d); c.beginPath(); full ? tracePath(c, G) : traceA(c, this.partA(t)); c.stroke(); }
          last = t.id;
        }
        return last;
      };
      if (!this.A || this.A.width !== cw || this.A.height !== ch || now < this.aAt || now - this.aAt > 120000) {
        this.A = fit(this.A); const J = this.newJob("A", this.A, now); this.step(J, Infinity, now);   // nothing valid to show: first frame, resize, seek
        this.aAt = now; this.aTo = J.maxId; this.job = null; this.bKey = null; this.bOld = true;
      } else if (!this.job && now - this.aAt > 30000) { this.backA = fit(this.backA); this.job = this.newJob("A", this.backA, now); }
      if (!this.job && !this.moving && (this.bKey !== this.rkey || this.bOld)) { this.backB = fit(this.backB); this.job = this.newJob("B", this.backB, now); }
      const J = this.job;
      if (J && J.kind === "B" && (J.key !== this.rkey || this.moving)) this.job = null;   // the ring moved: start again when it rests
      else if (J && this.step(J, this.o.sync ? Infinity : 1500, now)) {
        this.job = null;
        if (J.kind === "A") { J.c.setTransform(d, 0, 0, d, 0, 0); const last = catchUp(J.c, J.maxId, Infinity, false); const old = this.A; this.A = J.cv; this.backA = old; this.aAt = J.now; this.aTo = Math.max(J.maxId, last); this.bOld = true; }
        else { J.c.setTransform(d, 0, 0, d, 0, 0); catchUp(J.c, J.maxId, this.aTo, true); const old = this.B; this.B = J.cv; this.backB = old; this.bKey = J.key; this.bOld = false; }
      }
      // threads that cooled since the last build go straight onto A, and onto B while B matches the ring
      const cA = this.A.getContext("2d", { alpha: false }), cB = this.B && this.bKey === this.rkey ? this.B.getContext("2d", { alpha: false }) : null;
      cA.setTransform(d, 0, 0, d, 0, 0); if (cB) cB.setTransform(d, 0, 0, d, 0, 0);
      let i = T.length - 1;
      while (i >= 0 && T[i].id > this.aTo) i--;
      for (i++; i < T.length; i++) {
        const t = T[i], age = now - t.rt; if (age < HOT) break;
        styleBucket(cA, bucket(t, age), d); cA.beginPath(); traceA(cA, this.partA(t)); cA.stroke();
        const G = cB ? this.geom(t, now) : null;
        if (G) { styleBucket(cB, bucket(t, age), d); cB.beginPath(); tracePath(cB, G); cB.stroke(); }
        this.aTo = t.id;
      }
    }
    transientB(ctx, now) {   // ring halves of the newest cooled threads while B does not match the ring
      const T = this.E.trades, d = this.o.dpr, groups = new Map();
      let i = T.length - 1;
      while (i >= 0 && now - T[i].rt < HOT) i--;
      for (let k = 0; i >= 0 && k < 700; i--, k++) { const t = T[i], b = bucket(t, now - t.rt); let a = groups.get(b); if (!a) groups.set(b, (a = [])); a.push(t); }
      for (const [b, arr] of groups) { styleBucket(ctx, b, d); ctx.beginPath(); for (const t of arr) { const G = this.geom(t, now); if (G) traceB(ctx, G); } ctx.stroke(); }
    }
    web(ctx, now) {
      const g = this.g, E = this.E, d = this.o.dpr, T = E.trades, fresh = [];
      let i0 = T.length, up = 0, dn = 0;
      while (i0 > 0 && now - T[i0 - 1].rt < HOT) i0--;
      // hot threads (last 12 s), oldest first so the newest lie on top; brightness = recency × size
      for (let i = i0; i < T.length; i++) {
        const t = T[i], age = now - t.rt;
        if (age < 0) continue;
        const G = this.geom(t, now);
        if (!G) continue;
        const h = Math.exp(-age / 4500), z = szN(t.usd), col = t.up ? UP : DN, u = age < t._fl ? fly(age, t) : 1;
        ctx.strokeStyle = rgba(col, (0.06 + 0.56 * h) * (0.45 + 0.55 * z)); ctx.lineWidth = Math.min(1, 0.5 + 0.3 * z + 0.2 * h) / d;
        ctx.beginPath(); u < 1 ? tracePart(ctx, G, u) : tracePath(ctx, G); ctx.stroke();   // in flight the thread grows behind its spark
        if (h > 0.25 && u >= 0.5) { const r = 0.8 + (1 + 2 * z) * h; ctx.fillStyle = rgba(col, 0.85 * h); ctx.fillRect(G[6] - r / 2, G[7] - r / 2, r, r); }
        if (age < t._fl + 700) fresh.push(t);
        if (age < 10000) { if (G[13] < g.vt) up++; else if (G[13] > g.vb) dn++; }
      }
      this.portal[0] = up; this.portal[1] = dn;
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
    }
    // BTC book mid (white) and model (yellow) in the 15m and 5m windows: thin lines, a faint halo on 15m, and a ripple
    // on the head when the mid moves a tick or the model moves ≥ 1%; dimmed while the ring looks elsewhere
    btcLines(ctx, now) {
      const g = this.g, d = this.o.dpr, dim = this.focusS && this.focusS.kind === "eng" ? 1 : 0.35;
      for (const [tf, lw, dash] of [["5m", 0.8, [4, 3]], ["15m", 1.15, []]]) {
        const m = this.market({ a: "btc", tf, rel: 0 }, now);
        if (!m) continue;
        const f = tf === "15m", tau = m.end - now / 1000;
        const line = (pts, col, a, w) => {
          ctx.strokeStyle = rgba(col, a * dim); ctx.lineWidth = w; ctx.setLineDash(w > 2 ? [] : dash); ctx.beginPath();
          let on = false;
          for (const [t, v] of pts) {
            if (v == null || t > now) { on = false; continue; }
            const y = g.yP(v), x = g.xT(m.end - t / 1000, y);
            on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
          }
          ctx.stroke(); ctx.setLineDash([]);
        };
        if (f) { line(m.path, INK, 0.06, 4); line(m.fvPath, OURS, 0.07, 4); }
        line(m.path, INK, f ? 0.9 : 0.55, lw); line(m.fvPath, OURS, f ? 0.95 : 0.6, lw);
        ctx.strokeStyle = rgba(OURS, (f ? 0.32 : 0.18) * dim); ctx.lineWidth = 0.6; ctx.setLineDash([2, 5]); ctx.beginPath();
        for (let y = g.top; y <= g.bottom; y += 6) { const x = g.xT(tau, y); y === g.top ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
        tx(ctx, `сейчас BTC ${tf}`, g.xT(tau, g.top), g.top - (f ? 5 : -6), 8, rgba(OURS, (f ? 0.8 : 0.5) * dim), "center");
        const P = this.pulse[tf] || (this.pulse[tf] = { mid: null, mt: -1e9, fv: null, ft: -1e9 }), fv = m.mod && m.mod.fv;
        if (m.mid != null && m.mid !== P.mid) { if (P.mid != null) P.mt = now; P.mid = m.mid; }
        if (fv != null && (P.fv == null || Math.abs(fv - P.fv) >= 0.01)) { if (P.fv != null) P.ft = now; P.fv = fv; }
        const head = (v, col, at) => {
          const y = g.yP(v), x = g.xT(tau, y), k = (now - at) / 800, r = f ? 3 : 2.1;
          ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = rgba(col, dim); ctx.fill();
          if (k >= 0 && k < 1) { ctx.beginPath(); ctx.arc(x, y, r + 10 * k, 0, TAU); ctx.strokeStyle = rgba(col, 0.7 * (1 - k) * dim); ctx.lineWidth = 0.8 / d; ctx.stroke(); }
        };
        if (m.mid != null) head(m.mid, INK, P.mt);
        if (fv != null) head(fv, OURS, P.ft);
      }
    }
  }

  // ring.js and tiles.js add their methods to the class, and take the helpers from lib
  const mixin = (K) => { for (const k of Object.getOwnPropertyNames(K.prototype)) if (k !== "constructor") Object.defineProperty(Renderer.prototype, k, Object.getOwnPropertyDescriptor(K.prototype, k)); };
  const lib = { MONO, INK, UP, DN, OURS, WHITE, TZ, TZL, TF, TAU, C, fp, rgba, clock, utc, mmss, p3, pct, usd,
    money, dlt, sci, lerp, short, cents, dur, ago, nf, fitc, hash, tx, FLY, szN, canvasOf, LEGEND,
    PORT, tile };
  const mount = (canvas, eng, opts) => new Renderer(canvas, eng, opts);
  global.VesperaRender = { mount, Renderer, geometry, mixin, lib };
})(typeof window !== "undefined" ? window : globalThis);
