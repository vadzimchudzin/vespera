/* Vespera Engine Live — renderer, part ②③: the ring band (slots, sector edges, idle runs), its ticks and sector labels,
 * the engine rows, the edge marks of fills out of view, the rays (the focus book or the last fills), the minimap and
 * sector list, the card of the event in focus, the BTC "now" box and the legend. Methods of VesperaRender.Renderer. */
(function (global) {
  "use strict";
  const { MONO, INK, UP, DN, OURS, WHITE, TZ, TZL, TF, TAU, fp, rgba, clock, mmss, p3, pct, usd, money, dlt, sci,
    short, cents, dur, ago, nf, fitc, hash, tx, FLY, szN, canvasOf, LEGEND, PORT } = global.VesperaRender.lib;

  class Ring {
    // ② ------------------------------------------------------------------------------------
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
    // Text of a slot: [left, colour, alpha, right, right colour]; as many lines as the slot's height holds
    lines(s, n, now, big) { return s.kind === "eng" ? this.engLines(s, now, big) : s.kind === "ser" ? this.serLines(s, now, big) : this.evLines(s, n, now, big); }
    engLines(s, now, big) {
      const L = [], m = this.market(s, now), A = s.a.toUpperCase(), d = TF[s.tf], start = Math.floor(now / 1000 / d) * d + s.rel * d;
      if (!m) { L.push([`${A} ${s.tf} · ${clock(start * 1000)} · нет данных`, INK, 0.4]); return L; }
      const mod = m.mod || {}, x = m.exe || {}, tau = m.end - now / 1000, act = m.n && m.last.rt <= now ? ` · посл. ${((now - m.last.rt) / 1000).toFixed(1)} с` : "";
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
      if (big) {
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
      L.push([`${A} ${s.tf} · τ ${mmss(tau)} · ${p3(m.bb)}/${p3(m.ba)}${live ? ` · модель ${p3(mod.fv)}` : ""}`, s.a === "btc" ? OURS : INK, s.a === "btc" ? 0.9 : 0.85]);
      L.push(live ? [`edge UP ${pct(x.eu)} · DN ${pct(x.ed)} · σ60 ${sci(mod.sig)}`, OURS, 0.75] : [`модель выкл: ${mod.why || "нет данных"}`, INK, 0.45]);
      L.push([`K ${fp(m.K)} · S−K ${dlt(mod.S, m.K)}`, INK, 0.5]);
      L.push(m.pos ? [this.posLine(m.pos), OURS, 0.85] : [flow, INK, 0.45]);
      return L;
    }
    fillLine(T, now) {
      const W = this.E.wallets.get(T.w);
      return [`${T.side === "BUY" ? "купил" : "продал"} ${T.out || "?"} ${cents(T.price)} × ${nf(Math.round(T.size))} · ${usd(T.usd)} · ${W ? short(W) : ""}`, T.up ? UP : DN, 0.9, T.rt <= now ? ago(now, T.rt) : "", INK];
    }
    serLines(s, now, big) {
      const L = [], t = now / 1000, nw = s.ends ? s.ends.size : 0;
      let nx = null;
      if (s.ends) for (const e of s.ends.values()) if (e != null && e > t && (nx == null || e < nx)) nx = e;
      L.push([s.title, INK, big ? 1 : 0.88, nw ? `${nw} окон` : "", INK]);
      L.push([`${nx ? `ближ. итог через ${dur(nx - t)} · ` : ""}24ч ${usd(s.v24)}`, INK, 0.5]);
      if (s.n) L.push([`сессия: ${s.n} сд. · ${usd(s.usd)}`, INK, 0.6, s.last && s.last.rt <= now ? ago(now, s.last.rt) : "", INK]);
      if (big && s.last) L.push(this.fillLine(s.last, now));
      return L;
    }
    // markets of an event as Polymarket lists them: the likeliest first
    byPrice(s) {
      if (s._bp && s._bpN === s.n && s._bpD === s.det && s._bpM === s.mk.size) return s._bp;
      s._bp = [...s.mk.values()].filter((m) => !m.x).sort((a, b) => (b.p0 == null ? -1 : b.p0) - (a.p0 == null ? -1 : a.p0)); s._bpN = s.n; s._bpD = s.det; s._bpM = s.mk.size;
      return s._bp;
    }
    evLines(s, n, now, big) {
      const L = [], t = now / 1000, M = this.byPrice(s), m0 = M[0], one = M.length <= 1;
      const px = (m) => (m && m.p0 != null ? cents(m.p0) : "—");
      const hot = (m) => m && m.last && m.last.rt <= now && now - m.last.rt < 10000;
      const head = !m0 ? "" : one ? `${m0.o[0]} ${px(m0)}` : `${fitc(m0.q || m0.o[0], 84, 7.6)} ${px(m0)}`;
      L.push([s.title || s.slug, INK, big ? 1 : 0.88, head, hot(m0) ? (m0.last.up ? UP : DN) : INK]);
      if (n < 2) return L;
      const tau = s.end != null ? s.end - t : null;
      L.push([`${s.sub ? `${s.sub} · ` : ""}${tau == null ? "" : tau > 0 ? `итог через ${dur(tau)} · ` : "ждёт итога · "}24ч ${usd(s.v24)}${s.n ? ` · ${s.n} сд. ${usd(s.usd)}` : ""}`, INK, 0.5]);
      if (n < 3) return L;
      if (!m0) { if (s.det === 1 && this.o.mode !== "replay") L.push(["загрузка рынков…", INK, 0.35]); return L; }
      if (one) {
        L.push([`${m0.o[0]} ${px(m0)} · ${m0.o[1]} ${m0.p0 == null ? "—" : cents(1 - m0.p0)}${m0.bb != null && m0.ba != null ? ` · bid ${cents(m0.bb)} · ask ${cents(m0.ba)}` : ""}`, INK, 0.75]);
        if (s.last) L.push(this.fillLine(s.last, now));
        return L;
      }
      for (const m of M) {
        if (L.length >= n - (big && s.last ? 1 : 0)) break;
        const h = hot(m);
        L.push([m.q || m.o[0], h ? (m.last.up ? UP : DN) : INK, h ? 0.95 : 0.7, px(m), h ? (m.last.up ? UP : DN) : INK]);
      }
      if (big && s.last) L.push(this.fillLine(s.last, now));
      return L;
    }
    // the band: one slot per event, its sector's colour on the outer edge. At rest it is drawn 4 times a second into its
    // own layer (its text changes with prices and counts); while the ring moves it is drawn straight onto the frame.
    ring(ctx, now) {
      const g = this.g, rb = this.rb, d = this.o.dpr;
      if (this.moving) { this.ringK = null; this.band(ctx, now); }
      else {
        const k = `${this.rkey}|${Math.floor(now / 250)}`;
        if (k !== this.ringK) {
          this.ringK = k;
          if (!this.ringC) this.ringC = canvasOf();
          const cv = this.ringC, cw = Math.round(rb.w * d), ch = Math.round(g.mainH * d);
          if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
          const c = cv.getContext("2d");
          c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cw, ch); c.setTransform(d, 0, 0, d, -rb.x0 * d, 0);
          this.band(c, now);
        }
        ctx.drawImage(this.ringC, rb.x0, 0, rb.w, g.mainH);
      }
      this.ticks(ctx, now); this.secLabels(ctx);
    }
    band(c, now) {
      const g = this.g, U = this.U, V = this.vis, f = this.focusS, rb = this.rb;
      // the band and its two rolled-up ends depend on the canvas size only: one cached bitmap. Everything drawn on it
      // stays between the two edges, so the band needs no clip (a curved clip costs a mask on every draw).
      const d = this.o.dpr, bw = Math.round(rb.w * d), bh = Math.round(g.mainH * d);
      if (!this.base || this.base.width !== bw || this.base.height !== bh || this.baseK !== this.akey) {
        const cv = this.base || (this.base = canvasOf()); cv.width = bw; cv.height = bh; this.baseK = this.akey;
        const b = cv.getContext("2d"); b.setTransform(d, 0, 0, d, -rb.x0 * d, 0);
        b.beginPath(); b.arc(g.cx, g.cy, g.R, Math.PI * 0.5, Math.PI * 1.5); b.arc(g.cx, g.cy, g.Rin, Math.PI * 1.5, Math.PI * 0.5, true); b.closePath();
        b.fillStyle = "rgba(9,9,11,0.96)"; b.fill(); b.clip();
        b.strokeStyle = rgba(INK, 0.1); b.lineWidth = 0.5; b.beginPath();
        for (let k = 0; k < 7; k++) {
          const e = PORT * (1 - Math.exp(-k * 0.5));
          for (const y of [g.vt - e, g.vb + e]) { b.moveTo(g.arcX(y, g.R), y); b.lineTo(g.arcX(y, g.Rin), y); }
        }
        b.stroke();
      }
      c.save();
      c.drawImage(this.base, rb.x0, 0, rb.w, g.mainH);
      if (f && f._pl) {   // the focus slot, between the two edges
        const p = f._pl, n = 6; c.fillStyle = rgba(OURS, 0.035); c.beginPath();
        for (let k = 0; k <= n; k++) { const y = p.y0 + (p.h * k) / n; k ? c.lineTo(g.arcX(y, g.R), y) : c.moveTo(g.arcX(y, g.R), y); }
        for (let k = n; k >= 0; k--) { const y = p.y0 + (p.h * k) / n; c.lineTo(g.arcX(y, g.Rin), y); }
        c.closePath(); c.fill();
      }
      // sector colour on the outer edge, one path per run of a sector
      let cur = -1;
      for (const s of V) {
        const p = s._pl;
        if (s.sec !== cur) { if (cur >= 0) c.fill(); cur = s.sec; c.fillStyle = rgba(U.sec[cur].col, 0.55); c.beginPath(); }
        const xa = g.arcX(p.y0, g.R), xb = g.arcX(p.y1, g.R);
        c.moveTo(xa, p.y0); c.lineTo(xb, p.y1); c.lineTo(xb + 3.5, p.y1); c.lineTo(xa + 3.5, p.y0); c.closePath();
      }
      if (cur >= 0) c.fill();
      c.strokeStyle = rgba(INK, 0.075); c.lineWidth = 0.5; c.beginPath();
      for (const s of V) if (s.i !== U.sec[s.sec].i0 && s._pl.h > 1.2) { const y = s._pl.y0; c.moveTo(g.arcX(y, g.R), y); c.lineTo(g.arcX(y, g.Rin), y); }
      c.stroke();
      for (const s of V) if (s.i === U.sec[s.sec].i0) { const y = s._pl.y0; c.strokeStyle = rgba(U.sec[s.sec].col, 0.75); c.lineWidth = 1; c.beginPath(); c.moveTo(g.arcX(y, g.R), y); c.lineTo(g.arcX(y, g.Rin), y); c.stroke(); }
      let run = null;
      const endRun = () => {
        if (!run) return;
        const y0 = run.y0, y1 = run.y1, y = (y0 + y1) / 2 + 2.5;
        if (y1 - y0 >= 11 && run.n > 2) {
          const str = `··· ${nf(run.n)} ${run.idle === run.n ? "событий без сделок за 24 ч" : "событий"} ···`, x = g.arcX(y, g.R) + 12;
          c.fillStyle = "rgba(9,9,11,0.9)"; c.fillRect(x - 3, y - 7.5, str.length * 4.2 + 6, 10);
          tx(c, str, x, y, 7, rgba(INK, 0.42));
        }
        run = null;
      };
      for (const s of V) {
        const p = s._pl;
        if (p.h < 6.5) {
          if (!run) { run = { y0: p.y0, y1: p.y1, n: 0, idle: 0 }; c.fillStyle = rgba(INK, 0.16); }
          run.y1 = p.y1; run.n++; if (!s.v24 && !s.n) run.idle++;
          if (p.h >= 1.2) c.fillRect(g.arcX(p.yc, g.R) + 6, p.yc - 0.3, 26 + 30 * hash(s.key), 0.6);
          continue;
        }
        endRun();
        const big = s === f, lh = big ? 9.3 : p.h < 11 ? 6.6 : 8.4, size = big ? 8.3 : p.h < 11 ? 6 : 7.6;
        const n = Math.max(1, Math.min(big ? 12 : 9, Math.floor((p.h - 1.5) / lh))), L = this.lines(s, n, now, big);
        const k = Math.min(n, L.length), y0 = p.yc - (k * lh) / 2 + lh * 0.78;
        for (let j = 0; j < k; j++) {
          const [str, col, a, rs, rc] = L[j], y = y0 + j * lh, xl = g.arcX(y, g.R) + 12, xr = g.arcX(y, g.Rin) - 7;
          let w = xr - xl;
          if (rs) { tx(c, rs, xr, y, size, rgba(rc || col, Math.min(1, a + 0.08)), "right"); w -= rs.length * size * 0.6 + 8; }
          tx(c, fitc(str, w, size), xl, y, size, rgba(col, a));
        }
      }
      endRun();
      c.restore();
      for (const [r, w, a] of [[g.R, 1.2, 0.75], [g.R - 5, 0.5, 0.3], [g.Rin, 0.8, 0.35], [g.Rin + 4, 0.5, 0.15]]) {
        c.beginPath(); c.arc(g.cx, g.cy, r, Math.PI * 0.5, Math.PI * 1.5); c.strokeStyle = rgba(INK, a); c.lineWidth = w; c.stroke();
      }
    }
    // slot ticks on the outer edge flare as a fill lands; the marker shows the focus line
    ticks(ctx, now) {
      const g = this.g, U = this.U;
      for (const s of this.vis) {
        const p = s._pl;
        if (p.h < 2) continue;
        const xo = g.arcX(p.yc, g.R);
        let c = U.sec[s.sec].col, a = 0.5, last = s.last;
        if (s.kind === "eng") {
          const m = this.market(s, now); c = INK; a = 0.35;
          if (m) { const out = m.win != null ? m.win : m.rule; if (out != null) { c = out ? DN : UP; a = 0.95; } else if (s.rel === 0 && s.a === "btc") { c = OURS; a = 0.9; } }
          if (s.a === "btc") { const r = this.rec.get(s); last = r ? r[0] : null; }
        }
        const age = last ? now - last.rt - (last._fl || FLY) : -1, fl = age >= 0 ? Math.exp(-age / 500) : 0;
        ctx.fillStyle = rgba(c, a); ctx.fillRect(xo - 7, p.yc - 0.75, 7, 1.5);
        if (fl > 0.02) { ctx.fillStyle = rgba(last.up ? UP : DN, 0.9 * fl); ctx.fillRect(xo - 7 - 10 * fl, p.yc - 1, 7 + 10 * fl, 2); }
      }
      if (this.focusS) {
        const y = g.yF, x = g.arcX(y, g.R) - 19;
        ctx.fillStyle = rgba(OURS, 0.9); ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 4); ctx.closePath(); ctx.fill();
      }
    }
    // sector names outside the arc at each sector's start; the top one sticks until the next sector pushes it away
    secLabels(ctx) {
      const g = this.g, U = this.U, V = this.vis, L = [];
      for (const s of V) if (s === V[0] || s.i === U.sec[s.sec].i0) L.push(s);
      for (let k = 0; k < L.length; k++) {
        const s = L[k], S = U.sec[s.sec], nx = L[k + 1];
        let y = Math.max(s._pl.y0 + 10, g.vt + 10);
        if (nx) y = Math.min(y, nx._pl.y0 - 4);
        if (y < g.vt + 3 || y > g.vb - 2) continue;
        const str = `${S.label} · ${nf(S.n)}`, x = g.arcX(y, g.R) - 24, w = str.length * 4.8 + 8;
        ctx.fillStyle = "rgba(6,6,7,0.8)"; ctx.fillRect(x - w, y - 8, w + 4, 11);
        tx(ctx, str, x, y, 8, rgba(S.col, 0.95), "right", "bold");
      }
    }
    // the ends of the visible arc: what is next that way, how much of the ring is rolled up there, fills that flew there
    portals(ctx) {
      const g = this.g, U = this.U, V = this.vis, R = U.ring, n = R.length;
      if (!V.length || V.length >= n) return;
      const a = R[(V[0].i - 1 + n) % n], b = R[(V[V.length - 1].i + 1) % n], hid = n - V.length;
      for (const [s, y, k, ar] of [[a, g.vt - PORT / 2 + 3, 0, "▲"], [b, g.vb + PORT / 2 + 3, 1, "▼"]]) {
        const S = U.sec[s.sec], x = g.arcX(y, g.R) + 12;
        tx(ctx, fitc(`${ar} ${S.label} · ещё ${nf(Math.ceil(hid / 2))} · сделок туда за 10 с: ${this.portal[k]}`, g.band - 24, 7.6), x, y, 7.6, rgba(S.col, 0.9));
      }
    }

    // ③ ------------------------------------------------------------------------------------
    rays(ctx, now) {
      const f = this.focusS;
      for (const s of this.vis) {
        const p = s._pl;
        if (p.h < 1.5) continue;
        if (s === f && p.h > 24) {
          if (s.kind === "eng") {
            const m = this.market(s, now);
            if (m && m.bookRt) { const x = m.exe || {}; this.bookRays(ctx, p, this.E.levels(m), m.lvl, now, p3, `стакан UP · ${m.bids.size}/${m.asks.size} ур. · жёлтое = ${x.n || 5} ш по рынку`, x.up, x.dn); continue; }
          } else if (s.kind === "ev") {
            const hit = this.evBook(s);
            if (hit) { const [m, b] = hit; this.bookRays(ctx, p, this.U.levels(b), b.lvl, now, cents, `стакан ${m.o[0]} · ${fitc(m.q || s.title, 230, 8)} · ${b.bids.size}/${b.asks.size} ур.`); continue; }
            tx(ctx, this.o.mode === "replay" ? "стакана этого рынка нет в записи · последние сделки" : "стакан: подписка clob…", this.g.W - 16, p.y0 + 10, 8, rgba(INK, 0.45), "right");
          }
        }
        this.fillRays(ctx, s, p, now);
      }
    }
    evBook(s) {   // the leading market with a live book (a replay carries the books it recorded)
      for (const m of this.U.leads(s)) { const b = m.tk[0] && this.U.book(m.tk[0]); if (b && b.bookRt) return [m, b]; }
      return null;
    }
    // asks above the slot's middle, bids below, one ray per level (length ~ log size); a level that changed flashes white;
    // engine: yellow marks the levels a 5-share order would take
    bookRays(ctx, p, L, lvl, now, fmt, head, fa, fb) {
      const g = this.g, half = p.h / 2 - 4, n = Math.max(4, Math.min(26, Math.floor(half / 1.9))), lh = half / n;
      const heat = (side, q) => { const t = lvl.get(side + Math.round(q * 1e4)); return t == null || t > now ? 0 : Math.exp(-(now - t) / 1400); };
      for (const [side, levels, col, dir, f] of [["a", L.asks, DN, -1, fa], ["b", L.bids, UP, 1, fb]]) {
        for (let k = 0; k < Math.min(n, levels.length); k++) {
          const [q, sz] = levels[k], y = dir < 0 ? p.yc - (k + 1) * lh : p.yc + k * lh + 0.6, xs = g.arcX(y, g.Rin) + 8, h = heat(side, q);
          const len = Math.min(g.W - 16 - xs, 12 + 64 * Math.log10(1 + sz)), bh = Math.max(0.7, lh - 0.6);
          ctx.fillStyle = rgba(col, 0.3 + 0.6 * h); ctx.fillRect(xs, y, len, bh);
          if (h > 0.04) { ctx.fillStyle = rgba(WHITE, 0.7 * h); ctx.fillRect(xs + len, y, 2.5, bh); }
          if (f && (dir < 0 ? q <= f.worst + 1e-9 : 1 - q <= f.worst + 1e-9)) { ctx.fillStyle = rgba(OURS, 0.9); ctx.fillRect(xs - 5, y, 3, bh); }
          if (k === 0) tx(ctx, `${side === "a" ? "ask" : "bid"} ${fmt(q)} × ${nf(Math.round(sz))}`, xs + len + 8, y + (dir < 0 ? 0 : lh + 6), 8.5, rgba(col, 0.95));
        }
      }
      const xm = g.arcX(p.yc, g.Rin) + 8;
      ctx.strokeStyle = rgba(INK, 0.25); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(xm, p.yc); ctx.lineTo(g.W - 16, p.yc); ctx.stroke();
      tx(ctx, head, g.W - 16, p.y0 + 10, 8, rgba(INK, 0.5), "right");
    }
    fillRays(ctx, s, p, now) {   // the slot's newest fills, newest on top
      const g = this.g, list = this.rec.get(s);
      if (list) {
        const bh = Math.max(1.2, Math.min(2.5, p.h / 6)), n = Math.min(list.length, Math.max(1, Math.floor((p.h - 1.5) / bh)));
        for (let k = 0; k < n; k++) {
          const t = list[k], y = p.y0 + 0.8 + k * bh, xs = g.arcX(y, g.Rin) + 8, h = Math.exp(-(now - t.rt) / 4500);
          ctx.fillStyle = rgba(t.up ? UP : DN, 0.2 + 0.72 * h); ctx.fillRect(xs, y, Math.min(g.W - 16 - xs, 8 + 46 * Math.log10(1 + t.usd)), bh - 0.6);
        }
      }
      if (s.kind === "eng" && s.rel === -1 && p.h > 8 && p.yc > 150) {
        const m = this.market(s, now), out = m ? (m.win != null ? m.win : m.rule) : null;
        if (out != null) tx(ctx, `${out ? "▼ DOWN" : "▲ UP"} · twap ${fp(m.endTw)} ${out ? "<" : "≥"} K ${fp(m.K)}`, g.W - 16, p.yc + 3, 8.5, rgba(out ? DN : UP, 0.9), "right");
      }
    }

    // the whole ring in small: sectors by their share of the tape, the visible arc, the focus, and every fill of the
    // last 2 s wherever its market is; the list beside it jumps to a sector
    minimap(ctx, now) {
      const M = this.mm, U = this.U, L = U.len || 1, f = this.focusS, ang = (c) => -Math.PI / 2 + (c / L) * TAU;
      ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.beginPath(); ctx.arc(M.cx, M.cy, M.r + 13, 0, TAU); ctx.fill();
      ctx.lineWidth = 6;
      for (const S of U.sec) if (S.n && S.c1 > S.c0) {
        const a0 = ang(S.c0), a1 = ang(S.c1);
        ctx.strokeStyle = rgba(S.col, f && f.sec === S.i ? 0.95 : 0.5); ctx.beginPath(); ctx.arc(M.cx, M.cy, M.r, a0, Math.max(a0 + 0.004, a1 - 0.012)); ctx.stroke();
      }
      const V = this.vis;
      if (V.length) {
        const e = V[V.length - 1], a0 = ang(V[0].c);
        let a1 = ang(e.c + e.h); if (a1 < a0) a1 += TAU;
        ctx.strokeStyle = rgba(INK, 0.95); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(M.cx, M.cy, M.r + 7, a0, Math.max(a1, a0 + 0.07)); ctx.stroke();
      }
      if (f) {
        const a = ang(this.ui.P), co = Math.cos(a), si = Math.sin(a);
        ctx.strokeStyle = rgba(OURS, 1); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(M.cx + co * (M.r - 9), M.cy + si * (M.r - 9)); ctx.lineTo(M.cx + co * (M.r + 11), M.cy + si * (M.r + 11)); ctx.stroke();
      }
      const T = this.E.trades;
      for (let i = T.length - 1, k = 0; i >= 0 && k < 500; i--, k++) {
        const t = T[i], age = now - t.rt;
        if (age < 0) continue;
        if (age > 2000) break;
        const s = this.slotOf(t, now);
        if (!s) continue;
        const a = ang(s.c + s.h / 2), r = M.r - 6 - 12 * (age / 2000), z = 1.3 + 1.8 * szN(t.usd);
        ctx.fillStyle = rgba(t.up ? UP : DN, 0.95 * (1 - age / 2000)); ctx.fillRect(M.cx + Math.cos(a) * r - z / 2, M.cy + Math.sin(a) * r - z / 2, z, z);
      }
      tx(ctx, nf(U.ring.length), M.cx, M.cy, 9, rgba(INK, 0.9), "center", "bold");
      tx(ctx, "событий", M.cx, M.cy + 10, 7.5, rgba(INK, 0.5), "center");
      this.secList(ctx, now);
    }
    secList(ctx, now) {
      const L = this.sl, U = this.U, S = U.sec.filter((s) => s.n), f = this.focusS;
      ctx.fillStyle = "rgba(6,6,7,0.84)"; ctx.fillRect(L.x - 8, L.y - 11, L.w + 14, S.length * L.rh + 19);
      S.forEach((s, k) => {
        const y = L.y + k * L.rh, on = f && f.sec === s.i, r = U.rate(s, now);
        ctx.fillStyle = rgba(s.col, on ? 1 : 0.75); ctx.fillRect(L.x - 3, y - 6, 5, 5);
        tx(ctx, s.label, L.x + 6, y, 8.5, rgba(on ? s.col : INK, on ? 1 : 0.78), "left", on ? "bold" : "");
        tx(ctx, `${nf(s.n)} · ${r < 10 ? r.toFixed(1) : r.toFixed(0)}/с`, L.x + L.w, y, 8, rgba(INK, on ? 0.85 : 0.5), "right");
      });
      const c = U.cat;
      tx(ctx, `${c.done ? "каталог gamma" : "каталог грузится"} ${nf(c.rows)} · ×${this.ui.z.toFixed(2)} · видно ${this.vis.length}`, L.x - 3, L.y + S.length * L.rh + 2, 7.5, rgba(INK, 0.45));
    }
    // the event (or series) in focus: what it is, when it ends, its markets with prices, its newest fills
    card(ctx, now) {
      const f = this.focusS, g = this.g;
      if (!f || f.kind === "eng" || !f._pl) return;
      const S = this.U.sec[f.sec], t = now / 1000, R = [], bw = 392;
      R.push([`» ${f.title || f.slug}`, OURS, 1, "", null, 9.5, "bold"]);
      if (f.kind === "ev") {
        const tau = f.end != null ? f.end - t : null;
        const endS = f.end ? new Date(f.end * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", year: tau > 300 * 86400 ? "numeric" : undefined, hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—";
        R.push([`${S.label}${f.sub ? ` · ${f.sub}` : ""} · итог ${endS} ${TZL}${tau != null ? (tau > 0 ? ` · через ${dur(tau)}` : " · ждёт итога") : ""}`, S.col, 0.95]);
        R.push([`объём 24ч ${usd(f.v24)} · рынков ${f.nm || f.mk.size} · сессия ${f.n} сд. ${usd(f.usd)}`, INK, 0.6]);
        const M = this.byPrice(f);
        if (!M.length) R.push([this.o.mode === "replay" ? "рынков этого события нет в записи" : f.det === 1 ? "загрузка рынков…" : "рынки не загружены", INK, 0.4]);
        for (const m of M.slice(0, 7)) {
          const h = m.last && m.last.rt <= now && now - m.last.rt < 10000;
          const ba = m.bb != null && m.ba != null ? `${cents(m.bb)}/${cents(m.ba)}  ` : "";
          R.push([M.length > 1 ? m.q || m.o[0] : `${m.o[0]} / ${m.o[1]}`, h ? (m.last.up ? UP : DN) : INK, h ? 1 : 0.8, `${ba}${m.o[0]} ${m.p0 == null ? "—" : cents(m.p0)}`, h ? (m.last.up ? UP : DN) : INK]);
        }
        if (M.length > 7) R.push([`… ещё ${M.length - 7} рынков`, INK, 0.4]);
      } else {
        let nx = null;
        if (f.ends) for (const e of f.ends.values()) if (e != null && e > t && (nx == null || e < nx)) nx = e;
        R.push([`${S.label} · серия Up/Down · открыто окон ${f.ends ? f.ends.size : 0}${nx ? ` · ближ. итог через ${dur(nx - t)}` : ""}`, S.col, 0.95]);
        R.push([`объём 24ч ${usd(f.v24)} · сессия ${f.n} сд. ${usd(f.usd)}`, INK, 0.6]);
      }
      const rec = this.rec.get(f) || [];
      if (rec.length) R.push(["последние сделки", INK, 0.45]);
      for (const T of rec.slice(0, 4)) R.push(this.fillLine(T, now));
      const lh = 12.5, bh = R.length * lh + 10, p = f._pl, x = g.W - 16 - bw;
      let y = p.y1 + 16;
      if (y + bh > g.bottom) y = Math.max(g.top, p.y0 - 12 - bh);
      ctx.fillStyle = "rgba(6,6,7,0.88)"; ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = rgba(S.col, 0.45); ctx.lineWidth = 0.8; ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
      R.forEach(([s, col, a, rs, rc, size = 8.8, wt = ""], i) => {
        const yy = y + 14 + i * lh;
        let w = bw - 20;
        if (rs) { tx(ctx, rs, x + bw - 10, yy, size, rgba(rc || col, Math.min(1, a + 0.1)), "right"); w -= rs.length * size * 0.6 + 10; }
        tx(ctx, fitc(s, w, size), x + 10, yy, size, rgba(col, a), "left", wt);
      });
    }
    nowBox(ctx, now) {
      const g = this.g, f = this.focusS, tf = f && f.a === "btc" && f.rel === 0 ? f.tf : "15m";
      if (!f || f.a !== "btc") return;
      const m = this.market({ a: "btc", tf, rel: 0 }, now);
      if (!m) return;
      const mod = m.mod || {}, x = m.exe || {}, yH = g.yP(m.mid == null ? 0.5 : m.mid), xH = g.xT(m.end - now / 1000, yH);
      const n = x.n || m.min || 5, col = (e) => (e == null ? INK : e >= 0 ? UP : DN);
      const rows = [
        [`NOW ${mmss(now / 1000 - m.start)} / ${tf === "15m" ? "15:00" : "5:00"} · BTC ${tf} · ${clock(m.start * 1000)}–${clock(m.end * 1000)} ${TZL}`, OURS, 1],
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
  }
  global.VesperaRender.mixin(Ring);
})(typeof window !== "undefined" ? window : globalThis);
