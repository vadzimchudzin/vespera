/* Vespera · Engine Live — the agents' paper positions on the ring. Only inside the app, which feeds them through
 * window.vesperaRing every few seconds (src/main/ringPreload.js); the page on its own draws nothing extra.
 * A mark beside each event the desk holds, a box under the legend, and G / Shift+G to step through those events.
 * Wraps two methods of VesperaRender.Renderer: legend (drawn last, over the ring) and key. */
(function (global) {
  "use strict";
  const V = global.VesperaRender, bridge = global.vesperaRing;
  if (!V || !V.Renderer || !bridge || typeof bridge.onAgents !== "function") return;
  const { MONO, INK, UP, DN, OURS, rgba, tx } = V.lib;
  const STALE_MS = 15000;
  const st = { d: null, err: null, at: 0, held: new Map(), order: [], idx: -1 };

  const grouped = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const usd = (x) => { const v = Number(x) || 0; return `${v < 0 ? "−" : ""}$${grouped(Math.abs(v).toFixed(2))}`; };
  const signed = (x) => { const v = Number(x) || 0; return `${v > 0.004 ? "+" : v < -0.004 ? "−" : ""}$${grouped(Math.abs(v).toFixed(2))}`; };
  const tone = (x) => (Number(x) > 0.004 ? UP : Number(x) < -0.004 ? DN : INK);
  const HALTS = { manual: "ручная остановка", daily_loss: "дневной убыток", drawdown: "просадка от пика" };

  bridge.onAgents((d) => {
    st.at = Date.now();
    if (!d || d.ok === false || !Array.isArray(d.events)) { st.err = (d && d.reason) || "agents_unavailable"; return; }
    st.err = null;
    st.d = d;
    st.held = new Map(d.events.map((e) => [`ev:${e.slug}`, e]));
    st.order = d.events.map((e) => `ev:${e.slug}`);
  });

  const P = V.Renderer.prototype, legend = P.legend, key = P.key;

  P.legend = function (ctx) {
    legend.call(this, ctx);
    if (!st.at) return;
    const g = this.g, d = st.d, stale = Date.now() - st.at > STALE_MS;
    // a mark on the outer edge of every visible event the desk holds; the focus gets its numbers
    if (d && !st.err) {
      for (const s of this.vis || []) {
        const e = st.held.get(s.key), p = s._pl;
        if (!e || !p || p.y1 < g.vt || p.y0 > g.vb) continue;
        const x = g.arcX(p.yc, g.R) - 6, y = p.yc, r = 2.6 + Math.min(2.4, Math.sqrt(e.cost / 25));
        ctx.fillStyle = rgba(OURS, stale ? 0.35 : 0.95);
        ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "rgba(6,6,7,0.9)"; ctx.lineWidth = 1; ctx.stroke();
        if (s === this.focusS) {
          const str = `агенты: ${e.n} поз. · ${usd(e.cost)} · ${signed(e.pnl)}`;
          ctx.font = `9px ${MONO}`;
          const w = ctx.measureText(str).width + 10;
          ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.fillRect(x - r - 8 - w, y - 8, w, 14);
          tx(ctx, str, x - r - 13, y + 2.5, 9, rgba(OURS, 0.95), "right");
        }
      }
    }
    // the box under the legend
    const x = g.x0 + 6, y = 64, lw = 410;
    ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.fillRect(x - 8, y - 12, lw, d && !st.err ? 31 : 18);
    if (st.err || !d) { tx(ctx, `АГЕНТЫ · недоступны (${st.err || "нет данных"})`, x, y, 9, rgba(INK, 0.6)); return; }
    const state = d.halt ? `стоп: ${HALTS[d.halt] || d.halt}` : d.running ? "работают" : "остановлены";
    tx(ctx, "АГЕНТЫ · БУМАГА", x, y, 9.5, rgba(OURS, stale ? 0.5 : 1), "left", "bold");
    tx(ctx, `${state}${stale ? " · нет связи с приложением" : ""}`, x + 104, y, 9, rgba(d.halt ? DN : INK, 0.75));
    let cx = x;
    const part = (label, value, color) => {
      tx(ctx, label, cx, y + 13, 9, rgba(INK, 0.5)); cx += ctx.measureText(label).width + 4;
      tx(ctx, value, cx, y + 13, 9, color); cx += ctx.measureText(value).width + 12;
    };
    part("капитал", usd(d.equity), rgba(INK, 0.9));
    part("P&L", signed(d.pnl), rgba(tone(d.pnl), 0.95));
    part("сегодня", signed(d.dayPnl), rgba(tone(d.dayPnl), 0.95));
    part("открыто", `${d.open} · ${usd(d.exposure)}`, rgba(INK, 0.9));
    if (st.order.length) tx(ctx, "G — к позиции", cx, y + 13, 9, rgba(INK, 0.4));
  };

  // G steps forward through the events the desk holds (largest first), Shift+G back
  P.key = function (k) {
    if ((k === "g" || k === "G") && st.d && !st.err) {
      const list = st.order.map((kk) => this.U.slots.get(kk)).filter(Boolean);
      if (list.length) {
        st.idx = (((st.idx + (k === "G" ? -1 : 1)) % list.length) + list.length) % list.length;
        this.gotoSlot(list[st.idx]);
        return true;
      }
    }
    return key.call(this, k);
  };
})(typeof window !== "undefined" ? window : globalThis);
