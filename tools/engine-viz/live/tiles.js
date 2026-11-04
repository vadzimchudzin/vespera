/* Vespera Engine Live — renderer, part ④: the panels under the ring (feeds, Chainlink, model graph, book, wallets,
 * paper test) and the command line. Methods of VesperaRender.Renderer. */
(function (global) {
  "use strict";
  const { MONO, INK, UP, DN, OURS, TZL, TAU, C, fp, rgba, clock, utc, mmss, p3, pct, usd, money, dlt, sci, lerp,
    short, nf, fitc, hash, tx, tile } = global.VesperaRender.lib;

  class Tiles {
    // ④ ------------------------------------------------------------------------------------
    focusName() {
      const f = this.focusS;
      if (!f) return "—";
      if (f.kind === "eng") return `${f.a}-${f.tf}${f.rel < 0 ? "-prev" : f.rel > 0 ? "-next" : ""}`;
      return f.kind === "ser" ? `${f.a}-updown-${f.tf}` : fitc(f.slug, 420, 11.5);
    }
    tiles(ctx, now) {
      const g = this.g, W = this.W, H = this.H, y0 = g.mainH, E = this.E;
      ctx.fillStyle = "#08080a"; ctx.fillRect(0, y0, W, H - y0);
      ctx.strokeStyle = rgba(INK, 0.14); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
      ["255,95,87", "254,188,46", "40,200,64"].forEach((c, i) => { ctx.beginPath(); ctx.arc(16 + i * 13, y0 + 16, 4, 0, TAU); ctx.fillStyle = rgba(c, 0.9); ctx.fill(); });
      tx(ctx, `vespera@engine ~ % live --markets all --focus ${this.focusName()} --mode paper ${Math.floor(now / 500) % 2 ? "▍" : " "}`, 62, y0 + 20, 11.5, rgba(INK, 0.92));
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
      const rows = [["trades", "rtds", "rtds · сделки"], ["chainlink", "rtds", "rtds · chainlink spot"], ["twap", "rtds", "rtds · twap 60 с"], ["clob", "clob", "clob · книги"], ["gamma", "gamma", `gamma · каталог ${nf(this.U.cat.rows)}`]];
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
      tile(ctx, x, y, w, h, "wallets --top", `${E.wallets.size} кош.`, "КОШЕЛЬКИ · объём за сессию, все рынки · YES/UP − NO/DOWN");
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
      tx(ctx, `сделок за минуту ${fills} · полоса: доля YES/UP (вправо) / NO/DOWN (влево)`, x + 10, y + h - 8, 8.5, rgba(INK, 0.45));
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
  global.VesperaRender.mixin(Tiles);
})(typeof window !== "undefined" ? window : globalThis);
