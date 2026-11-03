/* Vespera Engine Vision — concept renderer for Polymarket Up/Down markets.
 * Canvas 2D, no dependencies. Data: window.VESPERA_VIZ from build_data.py.
 * Zones: ① probability web, ② ring of 15-minute windows, ③ order-flow bars, ④ terminal tiles. */
(function (global) {
  "use strict";
  const MONO = '"JetBrains Mono","Andale Mono","Liberation Mono","DejaVu Sans Mono",monospace';
  const INK = "235,235,228", UP = "57,214,176", DOWN = "255,106,61", OURS = "255,211,77";
  const rgba = (c, a) => `rgba(${c},${a})`;

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const normal = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  function phi(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + (x < 0 ? -y : y));
  }
  // P(final 60 s Chainlink TWAP >= start price); the TWAP averages the last minute.
  function fairValue(s, k, sig, tau) {
    if (tau <= 0 || sig <= 0) return s >= k ? 1 : 0;
    const eff = tau > 60 ? tau - 40 : tau ** 3 / 10800;
    return phi(Math.log(s / k) / (sig * Math.sqrt(Math.max(eff, 1e-6))));
  }
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ts, tz) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
  const pct = (x, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
  const money = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
  const p3 = (x) => (x == null ? "—" : x.toFixed(3).replace(/^0/, ""));
  const pmAt = (path, sec) => { let b = null; for (const [t, p] of path || []) if (t <= sec) b = p; return b; };
  // Window id = 15-minute slot of the local day, so "w00" is 00:00 in the chosen time zone.
  const slotId = (ts, tz) => { const [h, m] = clock(ts, tz).split(":").map(Number); return `w${pad(h * 4 + Math.floor(m / 15))}`; };

  function prepare(D) {
    const cur = D.current, wins = D.windows.slice().sort((a, b) => a.ts - b.ts);
    const live = Object.assign({ ts: cur.ts, path: [], fv: [] }, wins.find((w) => w.ts === cur.ts));
    // Extend the printed price history to "now" with the live book mid.
    if (cur.pm != null) live.path = (live.path || []).filter(([s]) => s < cur.sec).concat([[cur.sec, cur.pm]]);
    const past = wins.filter((w) => w.ts < cur.ts);
    const slots = past.slice(-21).map((w) => ({ w, kind: "past" }));
    slots.push({ w: live, kind: "now" }, { w: { ts: cur.ts + 900 }, kind: "next" }, { w: { ts: cur.ts + 1800 }, kind: "next" });
    const r = mulberry(20261103), mc = [];
    if (cur.S && cur.K && cur.sigma) {
      for (let i = 0; i < 420; i++) {
        let s = cur.S;
        const pts = [[cur.sec, fairValue(s, cur.K, cur.sigma, 900 - cur.sec)]];
        for (let t = cur.sec + 5; t <= 900; t += 5) {
          s *= Math.exp(cur.sigma * Math.sqrt(5) * normal(r));
          pts.push([t, fairValue(s, cur.K, cur.sigma, 900 - t)]);
        }
        mc.push({ pts, up: s >= cur.K });
      }
    }
    const grain = [];
    for (let i = 0; i < 5200; i++) grain.push([r(), r(), r()]);
    return { wins, past, live, slots, mc, grain, upShare: mc.length ? mc.filter((m) => m.up).length / mc.length : null };
  }

  function geometry(W, H) {
    const mainH = Math.round(H * 0.735), R = W * 0.62, cx = W * 0.47 + R, cy = mainH * 0.36, band = W * 0.122;
    const arcX = (y, r) => cx - Math.sqrt(Math.max(r * r - (y - cy) ** 2, 0));
    const top = 46, bottom = mainH - 34;
    return { W, H, mainH, R, Rin: R - band, cx, cy, arcX, top, bottom, x0: 70,
      yP: (p) => top + 10 + (1 - p) * (bottom - top - 20) };
  }

  function text(ctx, s, x, y, { size = 10, color = rgba(INK, 0.8), align = "left", weight = "" } = {}) {
    ctx.font = `${weight} ${size}px ${MONO}`.trim();
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
  }
  function badge(ctx, n, x, y) {
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = rgba(OURS, 0.95); ctx.fill();
    text(ctx, String(n), x, y + 3.5, { size: 10, color: "#111", align: "center", weight: "bold" });
  }

  function drawWeb(ctx, g, M, D, t, opts) {
    const X = (sec, y) => g.x0 + (sec / 900) * (g.arcX(y, g.R) - 18 - g.x0);
    const poly = (pts, style, width) => {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
      pts.forEach(([s, p], k) => { const y = g.yP(p), x = X(s, y); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    // Isochrones: each minute of the window bends with the ring.
    for (let m = 0; m <= 15; m++) {
      ctx.strokeStyle = rgba(INK, m % 5 ? 0.035 : 0.08); ctx.lineWidth = 0.6; ctx.beginPath();
      for (let y = g.top; y <= g.bottom; y += 8) { const x = X(m * 60, y); y === g.top ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
      if (m % 5 === 0) text(ctx, `${m}m`, X(m * 60, g.bottom) , g.bottom + 14, { size: 9, color: rgba(INK, 0.35), align: "center" });
    }
    for (const [p, label] of [[1, "UP 1.00"], [0.5, "0.50"], [0, "DOWN 0.00"]]) {
      const y = g.yP(p);
      ctx.setLineDash([2, 5]); ctx.strokeStyle = rgba(INK, 0.16); ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(g.x0, y); ctx.lineTo(X(900, y), y); ctx.stroke(); ctx.setLineDash([]);
      text(ctx, label, g.x0 - 8, y + 3, { size: 9, color: rgba(INK, 0.45), align: "right" });
    }
    // Real Polymarket UP-price paths of past windows, each ending at its resolution.
    M.past.forEach((w, i) => {
      const age = 1 - i / Math.max(1, M.past.length - 1);
      const pts = w.path.slice();
      if (w.won !== null && w.won !== undefined) pts.push([900, w.won ? 1 : 0]);
      poly(pts, rgba(INK, 0.07 + 0.2 * (1 - age)), 0.8);
      if (i > M.past.length - 13) poly(w.fv, rgba(OURS, 0.08), 0.7);
    });
    // Engine forecast: 420 simulated futures of the live window in probability space.
    const grow = Math.min(1, t / 1.6);
    M.mc.forEach((m) => {
      const n = Math.max(2, Math.floor(m.pts.length * grow));
      poly(m.pts.slice(0, n), rgba(m.up ? UP : DOWN, 0.075), 0.7);
    });
    const cur = D.current;
    poly(M.live.path, rgba(INK, 0.95), 1.7);
    poly(cur.fvPath, rgba(OURS, 0.95), 1.5);
    (M.live.path || []).forEach(([s, p]) => {
      const y = g.yP(p), x = X(s, y);
      ctx.beginPath(); ctx.arc(x, y, 8.5, 0, Math.PI * 2); ctx.fillStyle = "#060607"; ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.9); ctx.lineWidth = 1.1; ctx.stroke();
      text(ctx, p.toFixed(2).replace(/^0/, ""), x, y + 2.6, { size: 7.5, color: rgba(INK, 0.95), align: "center" });
    });
    // Now: isochrone, pulsing head and readout.
    ctx.strokeStyle = rgba(OURS, 0.35); ctx.lineWidth = 0.8; ctx.setLineDash([3, 4]); ctx.beginPath();
    for (let y = g.top; y <= g.bottom; y += 6) { const x = X(cur.sec, y); y === g.top ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
    const yN = g.yP(cur.fv), xN = X(cur.sec, yN), pulse = 5 + 2.5 * Math.sin(t * 4);
    ctx.beginPath(); ctx.arc(xN, yN, pulse, 0, Math.PI * 2); ctx.strokeStyle = rgba(OURS, 0.9); ctx.lineWidth = 1.4; ctx.stroke();
    // Executable edge: buy UP at the ask or DOWN at 1 − bid, after the crypto taker fee.
    const fee = (p) => ((D.rules && D.rules.feeRate) || 0.07) * p * (1 - p);
    let best = null;
    if (cur.ask != null) best = { side: "UP", e: cur.fv - cur.ask - fee(cur.ask), px: cur.ask };
    if (cur.bid != null) {
      const px = 1 - cur.bid, e = 1 - cur.fv - px - fee(px);
      if (!best || e > best.e) best = { side: "DOWN", e, px };
    }
    const box = [
      [`NOW ${mmss(cur.sec)} / 15:00 · ${slotId(cur.ts, opts.tz)}`, rgba(OURS, 1)],
      [`model P(UP)  ${cur.fv.toFixed(3)}`, rgba(INK, 0.95)],
      [`book UP      ${p3(cur.bid)} / ${p3(cur.ask)}`, rgba(INK, 0.95)],
      [`taker edge   ${best == null ? "—" : `${pct(best.e)} ${best.side} @${p3(best.px)}`}`, best == null ? rgba(INK, 0.6) : rgba(best.e >= 0 ? UP : DOWN, 1)],
      [`futures ≥ K  ${M.upShare == null ? "—" : `${Math.round(M.upShare * 420)}/420`}`, rgba(INK, 0.7)],
      [`K ${cur.K.toFixed(2)} · S ${cur.S.toFixed(2)} binance`, rgba(INK, 0.55)],
      ["демо-модель · не торговый сигнал", rgba(INK, 0.38)],
    ];
    const bw = 236, bx = Math.min(xN + 18, X(900, yN) - bw - 14), by = Math.max(g.top + 70, Math.min(yN - 40, g.bottom - 110));
    ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.fillRect(bx - 8, by - 14, bw, box.length * 14 + 10);
    ctx.strokeStyle = rgba(OURS, 0.4); ctx.lineWidth = 0.8; ctx.strokeRect(bx - 8, by - 14, bw, box.length * 14 + 10);
    box.forEach(([s, c], i) => text(ctx, s, bx, by + i * 14, { size: 10, color: c }));
    badge(ctx, 1, g.x0 + 10, g.bottom - 6);
  }

  function slotGeom(g, n) {
    const h = (g.mainH - 28) / n;
    return { h, y: (i) => 14 + (i + 0.5) * h };
  }

  function drawRing(ctx, g, M, D, t, opts) {
    const S = slotGeom(g, M.slots.length);
    ctx.save();
    ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(g.cx, g.cy, g.Rin, Math.PI * 1.5, Math.PI * 0.5, true); ctx.closePath();
    ctx.fillStyle = "rgba(9,9,11,0.96)"; ctx.fill(); ctx.clip();
    M.slots.forEach((slot, i) => {
      const w = slot.w, yc = S.y(i), now = slot.kind === "now";
      if (slot.kind === "next") {
        text(ctx, `queued · 15m-${w.ts}`, g.arcX(yc, g.R) + 14, yc + 2, { size: 7, color: rgba(INK, 0.22) });
        return;
      }
      const p0 = w.path && w.path.length ? w.path[0][1] : null, fv5 = pmAt(w.fv, 300), pm5 = pmAt(w.path, 300);
      const tr = w.trade, out = w.won == null ? "live" : w.won ? "UP" : "DOWN";
      const basis = w.basis == null ? "" : ` · b ${w.basis >= 0 ? "+" : ""}${w.basis.toFixed(1)}`;
      const lines = [
        [`${clock(w.ts, opts.tz)} btc-updown-15m-${w.ts}`, rgba(INK, 0.55)],
        [`open ${p3(p0)} → ${out} · vol $${(w.vol || 0).toFixed(0)}`, rgba(INK, 0.42)],
        [fv5 == null ? "fv —" : `fv5 ${p3(fv5)} · pm ${p3(pm5)} · Δ ${pm5 == null ? "—" : pct(fv5 - pm5)}`, rgba(INK, 0.42)],
        [tr ? `demo ${tr.side.toUpperCase()} @${p3(tr.price)} fv ${p3(tr.fv)} · ${tr.won ? "hit" : "miss"}` : "no signal · Δ < fee + 3%", tr ? rgba(OURS, 0.7) : rgba(INK, 0.3)],
        [w.ptb ? `K ${w.ptb.toFixed(2)} chainlink${basis}` : `K ≈ ${w.K ? w.K.toFixed(2) : "—"} binance`, rgba(INK, 0.3)],
      ];
      lines.forEach(([s, c], k) => {
        const y = yc - 11 + k * 6.3;
        text(ctx, s, g.arcX(y, g.R) + 14, y + 2, { size: now ? 7 : 6.6, color: now ? rgba(INK, 0.95) : c });
      });
    });
    ctx.restore();
    for (const [r, wdt, a] of [[g.R, 2.4, 0.9], [g.R - 5, 0.6, 0.45], [g.R - 9, 0.5, 0.25], [g.Rin, 1, 0.45], [g.Rin + 4, 0.5, 0.2]]) {
      ctx.beginPath(); ctx.arc(g.cx, g.cy, r, Math.PI * 0.5, Math.PI * 1.5); ctx.strokeStyle = rgba(INK, a); ctx.lineWidth = wdt; ctx.stroke();
    }
    M.slots.forEach((slot, i) => {
      const yc = S.y(i), w = slot.w, xo = g.arcX(yc, g.R), xi = g.arcX(yc, g.Rin);
      ctx.strokeStyle = rgba(INK, 0.8); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xo - 6, yc); ctx.lineTo(xo + 3, yc); ctx.stroke();
      const id = slotId(w.ts, opts.tz);
      if (slot.kind === "next") { text(ctx, `${id} ${clock(w.ts, opts.tz)} ··`, xi - 8, yc + 3, { size: 9, color: rgba(INK, 0.3), align: "right" }); return; }
      const glyph = w.won == null ? "●" : w.won ? "▲" : "▼", gc = w.won == null ? OURS : w.won ? UP : DOWN;
      const now = slot.kind === "now";
      text(ctx, glyph, xi - 8, yc + 3, { size: 9, color: rgba(gc, now ? 0.6 + 0.4 * Math.abs(Math.sin(t * 3)) : 0.9), align: "right" });
      text(ctx, `${now ? "» " : ""}${id} ${clock(w.ts, opts.tz)}`, xi - 22, yc + 3, { size: now ? 10 : 9, color: rgba(INK, now ? 1 : 0.78), align: "right", weight: now ? "bold" : "" });
      if (w.trade) {
        ctx.beginPath(); ctx.arc(xi - 4, yc + 10, 2.1, 0, Math.PI * 2); ctx.strokeStyle = rgba(OURS, 0.8); ctx.lineWidth = 0.9; ctx.stroke();
        if (w.trade.won) { ctx.fillStyle = rgba(OURS, 0.8); ctx.fill(); }
      }
    });
    badge(ctx, 2, g.arcX(S.y(1), g.R) + 40, S.y(1) - 10);
  }

  function drawFlow(ctx, g, M, D, t) {
    const S = slotGeom(g, M.slots.length), recentFrom = M.slots.length - 10;
    M.slots.forEach((slot, i) => {
      const w = slot.w, yc = S.y(i);
      if (slot.kind === "next") {
        for (let k = 0; k < 5; k++) { const y = yc - 8 + k * 4, xs = g.arcX(y, g.Rin) + 6; ctx.fillStyle = rgba(INK, 0.06); ctx.fillRect(xs, y, 40 + k * 9, 1); }
        return;
      }
      const p = w.path || [], bars = [{ len: 46 + 44 * Math.log10(1 + (w.vol || 0)), kind: "vol" }];
      for (let k = 1; k < p.length; k++) bars.push({ len: 16 + Math.abs(p[k][1] - p[k - 1][1]) * 1500, d: p[k][1] - p[k - 1][1], sec: p[k][0] });
      if (w.won != null && p.length) bars.push({ len: 24 + Math.abs((w.won ? 1 : 0) - p[p.length - 1][1]) * 900, d: w.won ? 1 : -1, fin: true });
      const bh = Math.min(2.6, (S.h - 3) / bars.length);
      bars.forEach((b, k) => {
        const y = yc - S.h / 2 + 1.5 + k * bh, xs = g.arcX(y, g.Rin) + 6;
        const len = Math.min(b.len * (1 + 0.045 * Math.sin(t * 2.3 + i * 1.7 + k * 0.9)), g.W - 26 - xs);
        let c;
        if (w.trade && b.sec === w.trade.sec) c = rgba(OURS, 0.95);
        else if (b.kind === "vol") c = rgba(INK, 0.85);
        else if (i >= recentFrom) c = rgba(b.d >= 0 ? UP : DOWN, 0.5 + Math.min(0.5, Math.abs(b.d) * 5));
        else c = rgba(INK, 0.22 + Math.min(0.65, Math.abs(b.d) * 7));
        ctx.fillStyle = c; ctx.fillRect(xs, y, len, Math.max(0.7, bh - 0.55));
      });
    });
    badge(ctx, 3, g.W - 44, g.mainH - 30);
  }

  function tile(ctx, x, y, w, h, cmd, meta, cap) {
    ctx.fillStyle = "#0b0b0d"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(INK, 0.09); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.beginPath(); ctx.arc(x + 10, y + 12, 2.6, 0, Math.PI * 2); ctx.fillStyle = rgba(UP, 0.9); ctx.fill();
    text(ctx, `~ % ${cmd}`, x + 18, y + 15, { size: 10, color: rgba(INK, 0.9) });
    text(ctx, meta, x + w - 8, y + 15, { size: 9, color: rgba(INK, 0.45), align: "right" });
    text(ctx, cap, x + 10, y + 31, { size: 8.5, color: rgba(INK, 0.5) });
  }

  function drawTerminal(ctx, g, M, D, t, opts) {
    const y0 = g.mainH, W = g.W, H = g.H;
    ctx.fillStyle = "#08080a"; ctx.fillRect(0, y0, W, H - y0);
    ctx.strokeStyle = rgba(INK, 0.14); ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
    ["255,95,87", "254,188,46", "40,200,64"].forEach((c, i) => { ctx.beginPath(); ctx.arc(16 + i * 13, y0 + 16, 4, 0, Math.PI * 2); ctx.fillStyle = rgba(c, 0.9); ctx.fill(); });
    const cursor = Math.floor(t * 2) % 2 ? "▍" : " ";
    text(ctx, `vespera@engine ~ % run vespera-v2 --market btc-updown-15m --windows ${D.windows.length} --mode paper ${cursor}`, 62, y0 + 20, { size: 11.5, color: rgba(INK, 0.92) });
    text(ctx, `live data · ${new Date(D.generatedAt * 1000).toISOString().slice(11, 19)} UTC · ${opts.tzLabel}`, W - 14, y0 + 20, { size: 10, color: rgba(INK, 0.5), align: "right" });
    badge(ctx, 4, W * 0.5, y0 + 16);
    const gap = 8, tx = 10, ty = y0 + 32, th = H - ty - 10, tw = (W - tx * 2 - gap * 5) / 6;
    const X = (i) => tx + i * (tw + gap);
    // 1. feeds
    tile(ctx, X(0), ty, tw, th, "feeds --latency", "rtt ms", "SOURCES");
    const lat = Object.entries(D.latency || {});
    lat.forEach(([k, v], i) => {
      const yy = ty + 50 + i * 20;
      text(ctx, k.padEnd(9), X(0) + 10, yy, { size: 10, color: rgba(INK, 0.8) });
      text(ctx, `${v.toFixed(0)} ms`, X(0) + tw - 10, yy, { size: 10, color: rgba(INK, 0.9), align: "right" });
      const bw = Math.min(tw - 150, 18 * Math.log2(1 + v));
      ctx.fillStyle = rgba(v < 100 ? UP : v < 400 ? OURS : DOWN, 0.85); ctx.fillRect(X(0) + 88, yy - 7, bw, 6);
    });
    // BTC 1 s over the last 15 minutes: shaded minute = Chainlink TWAP window that sets K.
    const cur = D.current, sp = cur.spark || cur.path1s || [], sx0 = X(0) + 10, sx1 = X(0) + tw - 10;
    const sy0 = ty + 50 + lat.length * 20 + 14, sy1 = ty + th - 46;
    if (sp.length > 1 && sy1 - sy0 > 30) {
      const tA = cur.sec - 900, vals = sp.map((p) => p[1]).concat([cur.K]), lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 1);
      const px = (s) => sx0 + ((s - tA) / 900) * (sx1 - sx0), py = (v) => sy1 - ((v - lo) / span) * (sy1 - sy0);
      if (px(0) > sx0) {
        ctx.fillStyle = rgba(OURS, 0.1); ctx.fillRect(Math.max(sx0, px(-60)), sy0, px(0) - Math.max(sx0, px(-60)), sy1 - sy0);
        ctx.strokeStyle = rgba(INK, 0.25); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(px(0), sy0); ctx.lineTo(px(0), sy1); ctx.stroke();
      }
      ctx.setLineDash([2, 4]); ctx.strokeStyle = rgba(OURS, 0.7); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(Math.max(sx0, px(0)), py(cur.K)); ctx.lineTo(sx1, py(cur.K)); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = rgba(INK, 0.85); ctx.lineWidth = 1; ctx.beginPath();
      sp.forEach(([s, v], k) => (k ? ctx.lineTo(px(s), py(v)) : ctx.moveTo(px(s), py(v))));
      ctx.stroke();
      const [ls, lv] = sp[sp.length - 1];
      ctx.beginPath(); ctx.arc(px(ls), py(lv), 2.4, 0, Math.PI * 2); ctx.fillStyle = rgba(lv >= cur.K ? UP : DOWN, 1); ctx.fill();
      text(ctx, `BTC 1s · 15 мин · S−K ${lv - cur.K >= 0 ? "+" : "−"}$${Math.abs(lv - cur.K).toFixed(0)}`, sx0, sy0 - 4, { size: 8.5, color: rgba(INK, 0.55) });
      text(ctx, "K", Math.max(sx0, px(0)) + 3, py(cur.K) - 3, { size: 8, color: rgba(OURS, 0.8) });
    }
    const bs = D.basis, usd = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(0)}`;
    text(ctx, bs ? `binance − chainlink ${usd(bs.recent)} · 24ч ${usd(bs.min)}…${usd(bs.max)}` : "pm ← binance: 347 ms (медиана)", X(0) + 10, ty + th - 26, { size: 9, color: rgba(INK, 0.5) });
    text(ctx, "resolve: chainlink twap 60s", X(0) + 10, ty + th - 12, { size: 9, color: rgba(OURS, 0.7) });
    // 2. edge per hour
    const eh = D.edgeHourly || [], tot = eh.reduce((a, b) => a + b, 0), ehMax = Math.max(1, ...eh);
    tile(ctx, X(1), ty, tw, th, "edge --hourly", `${tot} срезов`, "EDGE / HOUR  |fv − pm| > 3%");
    const cw = (tw - 20) / 24;
    eh.forEach((v, i) => {
      const n = Math.round((v / ehMax) * 22);
      for (let k = 0; k < n; k++) { ctx.fillStyle = rgba(i === eh.length - 1 ? OURS : INK, 0.22 + 0.03 * k); ctx.fillRect(X(1) + 10 + i * cw, ty + th - 22 - k * 7, cw - 2.5, 5); }
    });
    text(ctx, "24 ч назад → сейчас", X(1) + 10, ty + th - 8, { size: 8.5, color: rgba(INK, 0.4) });
    // 3. clock heat: a 24 h dial of 96 slots, share of UP 15 m candles.
    tile(ctx, X(2), ty, tw, th, "clock --heat", "90 дн", "CLOCK  доля UP по слотам 15 мин, UTC");
    const cl = D.clock || [], ccx = X(2) + tw / 2, ccy = ty + 40 + (th - 70) / 2, r1 = Math.min(tw - 40, th - 76) / 2, r0 = r1 * 0.58;
    const curSlot = Math.floor((D.current.ts % 86400) / 900);
    cl.forEach((v, s) => {
      const a0 = -Math.PI / 2 + (s / 96) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / 96 - 0.012, d = v - 0.5;
      ctx.beginPath(); ctx.arc(ccx, ccy, r1, a0, a1); ctx.arc(ccx, ccy, r0 + (s % 4 === 0 ? 0 : 3), a1, a0, true); ctx.closePath();
      ctx.fillStyle = rgba(d >= 0 ? UP : DOWN, Math.min(0.95, 0.1 + Math.abs(d) * 6)); ctx.fill();
      if (s === curSlot) { ctx.strokeStyle = rgba(OURS, 0.6 + 0.4 * Math.abs(Math.sin(t * 3))); ctx.lineWidth = 1.4; ctx.stroke(); }
    });
    [0, 6, 12, 18].forEach((h) => {
      const a = -Math.PI / 2 + (h / 24) * Math.PI * 2;
      text(ctx, pad(h), ccx + Math.cos(a) * (r1 + 9), ccy + Math.sin(a) * (r1 + 9) + 3, { size: 8, color: rgba(INK, 0.45), align: "center" });
    });
    const cv = cl[curSlot];
    text(ctx, cv == null ? "—" : `${(cv * 100).toFixed(0)}%`, ccx, ccy + 4, { size: 15, color: rgba(INK, 0.95), align: "center", weight: "bold" });
    text(ctx, "UP сейчас", ccx, ccy + 17, { size: 8, color: rgba(INK, 0.45), align: "center" });
    const hot = cl.map((v, s) => [v, s]).sort((a, b) => b[0] - a[0])[0] || [0.5, 0];
    const noise = D.clockN ? 50 / Math.sqrt(D.clockN) : null;
    text(ctx, `макс ${(hot[0] * 100).toFixed(0)}% в ${pad(Math.floor(hot[1] / 4))}:${pad((hot[1] % 4) * 15)}${noise ? ` · шум ±${noise.toFixed(0)}% (n ${D.clockN})` : ""}`, X(2) + 10, ty + th - 10, { size: 8.5, color: rgba(INK, 0.45) });
    // 4. order book
    const bk = D.book || { bids: [], asks: [] };
    tile(ctx, X(3), ty, tw, th, "book --depth", `${bk.bids.length} bid · ${bk.asks.length} ask`, `ORDER BOOK  UP · tick ${bk.tick || "—"} · min ${bk.minSize || "—"}`);
    const cells = [...bk.bids.slice().sort((a, b) => b[0] - a[0]).map((l) => [l, UP]), ...bk.asks.slice().sort((a, b) => a[0] - b[0]).map((l) => [l, DOWN])];
    const cols = 18, cs = Math.min((tw - 20) / cols, (th - 66) / 6), maxSz = Math.max(1, ...cells.map(([l]) => l[1]));
    cells.slice(0, cols * 6).forEach(([[, sz], c], i) => {
      ctx.fillStyle = rgba(c, 0.18 + 0.8 * Math.sqrt(sz / maxSz));
      ctx.fillRect(X(3) + 10 + (i % cols) * cs, ty + 42 + Math.floor(i / cols) * cs, cs - 2, cs - 2);
    });
    const bb = bk.bids.length ? Math.max(...bk.bids.map((l) => l[0])) : null, ba = bk.asks.length ? Math.min(...bk.asks.map((l) => l[0])) : null;
    text(ctx, `bid ${bb == null ? "—" : bb.toFixed(3)} · ask ${ba == null ? "—" : ba.toFixed(3)}`, X(3) + 10, ty + th - 10, { size: 9, color: rgba(INK, 0.6) });
    // 5. markets globe
    tile(ctx, X(4), ty, tw, th, "markets --globe", `${(D.markets || []).length} live`, "OPEN MARKETS  up/down 15m");
    const gx = X(4) + tw * 0.42, gy = ty + th * 0.58, gr = Math.min(tw, th) * 0.34, rot = t * 0.35;
    for (let la = -75; la <= 75; la += 15) for (let lo = 0; lo < 360; lo += 12) {
      const a = (la * Math.PI) / 180, b = (lo * Math.PI) / 180 + rot, z = Math.cos(a) * Math.sin(b);
      if (z < 0) continue;
      ctx.fillStyle = rgba(INK, 0.12 + 0.6 * z); ctx.fillRect(gx + gr * Math.cos(a) * Math.cos(b), gy - gr * Math.sin(a), 1.6, 1.6);
    }
    (D.markets || []).forEach((m, i) => {
      const a = (-35 + i * 25) * Math.PI / 180, px = gx + gr * 0.55 * Math.cos(a + i), py = gy - gr * Math.sin(a);
      ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fillStyle = rgba(m.up >= 0.5 ? UP : DOWN, 1); ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.4); ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(X(4) + tw - 70, ty + 46 + i * 16); ctx.stroke();
      text(ctx, `${m.asset} ${m.up >= 0.5 ? "▲" : "▼"}${m.up.toFixed(2)}`, X(4) + tw - 8, ty + 49 + i * 16, { size: 9.5, color: rgba(INK, 0.9), align: "right" });
    });
    // 6. V1 vs V2 check
    const v1 = D.v1, pn = D.pnl || {};
    tile(ctx, X(5), ty, tw, th, "check --v1-vs-v2", "paper", "V1 SMA 20/200 · реальные цены PM");
    if (v1) {
      text(ctx, `n ${v1.n} · win ${(v1.wins / v1.n * 100).toFixed(1)}% · ${v1.days} дн`, X(5) + 10, ty + 50, { size: 9.5, color: rgba(INK, 0.75) });
      text(ctx, `вход ${v1.avgEntry.toFixed(3)} · безубыток ≈ ${(v1.avgEntry * 100 + 1.8).toFixed(1)}%`, X(5) + 10, ty + 64, { size: 9.5, color: rgba(INK, 0.55) });
      text(ctx, money(v1.net), X(5) + 10, ty + 104, { size: 34, color: rgba(v1.net < 0 ? DOWN : UP, 1), weight: "bold" });
    }
    text(ctx, `демо-сигналов за 24 ч: ${pn.n || 0} (без стакана)`, X(5) + 10, ty + th - 26, { size: 9.5, color: rgba(OURS, 0.85) });
    text(ctx, "сертификат: нет · нужен стакан (M0–M1)", X(5) + 10, ty + th - 12, { size: 9, color: rgba(INK, 0.5) });
  }

  function drawLegend(ctx, g, D, M, opts) {
    const rows = [
      "① облако: реальные окна BTC 15m на Polymarket (белые нити) и 420 прогнозов движка на текущее окно",
      "② кольцо: 15-минутные окна — решения движка и итог по Chainlink TWAP",
      "③ поток: изменение цены UP по минутам; жёлтое — демо-сигналы (по истории цен, не по стакану)",
      "④ панели: задержки, перевес, часы, стакан, рынки, проверка V1/V2",
    ];
    const x = g.x0 + 14, y = 22;
    ctx.fillStyle = "rgba(6,6,7,0.8)"; ctx.fillRect(x - 10, y - 14, 640, 18 + rows.length * 14 + 6);
    text(ctx, "VESPERA · ENGINE VISION", x, y, { size: 12, color: rgba(INK, 1), weight: "bold" });
    text(ctx, `концепт · живые данные Polymarket · ${opts.tzLabel}`, x + 196, y, { size: 10, color: rgba(INK, 0.5) });
    rows.forEach((r, i) => text(ctx, r, x, y + 18 + i * 14, { size: 10, color: rgba(INK, 0.72) }));
  }

  function draw(ctx, W, H, D, M, t, opts) {
    const g = geometry(W, H);
    ctx.fillStyle = "#060607"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, g.mainH); ctx.clip();
    const vg = ctx.createRadialGradient(W * 0.3, g.mainH * 0.45, 40, W * 0.3, g.mainH * 0.45, W * 0.75);
    vg.addColorStop(0, "rgba(40,40,44,0.35)"); vg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, g.mainH);
    M.grain.forEach(([a, b, c]) => { ctx.fillStyle = rgba(INK, 0.02 + c * 0.05); ctx.fillRect(a * W, b * g.mainH, 1, 1); });
    drawWeb(ctx, g, M, D, t, opts);
    drawFlow(ctx, g, M, D, t);
    drawRing(ctx, g, M, D, t, opts);
    drawLegend(ctx, g, D, M, opts);
    ctx.restore();
    drawTerminal(ctx, g, M, D, t, opts);
  }

  function mount(canvas, data, options = {}) {
    const opts = Object.assign({ tz: "Etc/GMT-3", tzLabel: "UTC+3", animate: true, dpr: global.devicePixelRatio || 1 }, options);
    const M = prepare(data), ctx = canvas.getContext("2d");
    let W = 0, H = 0;
    const resize = () => {
      W = opts.width || global.innerWidth; H = opts.height || global.innerHeight;
      canvas.width = Math.round(W * opts.dpr); canvas.height = Math.round(H * opts.dpr);
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
    };
    resize();
    const render = (t) => draw(ctx, W, H, data, M, t, opts);
    global.__vizDraw = render;
    if (opts.animate) {
      const t0 = performance.now();
      const loop = () => { render((performance.now() - t0) / 1000); global.requestAnimationFrame(loop); };
      global.addEventListener("resize", resize);
      loop();
    } else render(opts.t == null ? 2 : opts.t);
    return { render };
  }

  global.VesperaViz = { mount, fairValue };
})(typeof window !== "undefined" ? window : globalThis);
