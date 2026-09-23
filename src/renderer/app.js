(() => {
  const $ = (id) => document.getElementById(id);
  const t = (key) => (window.VSP_I18N[state.locale] || window.VSP_I18N.en)[key] || key;
  // "one|few|many" unit forms (RU needs three); a plain unit is used as is.
  const plural = (n, forms) => {
    const f = String(forms).split("|");
    if (f.length < 3) return f.length === 2 ? (n === 1 ? f[0] : f[1]) : f[0];
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return f[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return f[1];
    return f[2];
  };
  // Venue responses end up in innerHTML; never let them inject markup.
  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const state = {
    locale: "en",
    theme: "glass-dark",
    running: false,
    mode: "paper",
    snapshot: null,
    openMenu: null,
    pairLabel: "",
    chromeKey: "",
    saveTimer: 0,
    savingPanel: false,
  };

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.documentElement.lang = state.locale;
    const menu = $("btnMenu");
    if (menu) menu.title = t("menu");
    const lamp = $("statusLamp");
    if (lamp && lamp.dataset.status) lamp.title = statusLabel(lamp.dataset.status);
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    if (window.VesperaChart && window.VesperaChart.applyTheme) {
      window.VesperaChart.applyTheme();
    }
  }

  function statusLabel(status) {
    return (
      {
        stopped: t("stopped"),
        warming_up: t("warming"),
        watching: t("watching"),
        order_sent: t("orderSent"),
        waiting_settlement: t("waiting"),
        halt: t("halt"),
      }[status] || status
    );
  }

  function money(n) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function reasonText(reason) {
    if (!reason) return "";
    return t(`reason_${reason}`) !== `reason_${reason}` ? t(`reason_${reason}`) : String(reason).replace(/_/g, " ");
  }

  function logLine(row) {
    const when = (row.ts || "").slice(11, 19);
    const type = row.type;
    let title = type;
    let detail = "";
    if (type === "start") title = t("logStart");
    else if (type === "stop") title = t("logStop");
    else if (type === "mode") {
      title = t("logMode");
      detail = row.mode === "auto" ? t("auto") : t("paper");
    } else if (type === "skip") {
      title = t("logSkip");
      detail = reasonText(row.reason);
    } else if (type === "setup") {
      title = t("logSetup");
      detail = [row.signal || row.side, reasonText(row.reason)].filter(Boolean).join(" · ");
    } else if (type === "order_sent") {
      title = t("logOrder");
      detail = `${row.side || ""} · $${row.sizeUsd || ""}`.trim();
    } else if (type === "settled") {
      title = row.status === "win" ? t("logWin") : t("logLoss");
      detail = `${row.side || ""} · $${row.pnl || ""}`.trim();
    } else if (type === "halt") title = t("logHalt");
    else if (type === "lot_confirmed") {
      title = t("logLot");
      detail = row.baseUsd ? `$${row.baseUsd}` : "";
    } else if (type === "api_ping") title = t("logPing");
    else if (type === "data_error" || type === "order_error") {
      title = t("logError");
      detail = row.message || "";
    } else if (type === "strategy") {
      title = t("logStrategy");
      detail = row.strategyId || "";
    } else if (type === "auto_blocked") {
      title = t("logError");
      detail = reasonText(row.reason);
    } else if (type === "paper_reset") {
      title = t("logReset");
      detail = row.balance ? `$${row.balance}` : "";
    }
    return { when, title, detail, kind: type };
  }

  function renderLog(snap) {
    const log = $("log");
    log.innerHTML = "";
    const rows = snap.log || [];
    if (!rows.length) {
      log.textContent = t("logEmpty");
      return;
    }
    rows.slice(0, 16).forEach((row) => {
      const line = logLine(row);
      const div = document.createElement("div");
      div.className = `log-row log-${line.kind}`;
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = line.when;
      const body = document.createElement("span");
      body.className = "log-body";
      body.textContent = line.detail ? `${line.title} · ${line.detail}` : line.title;
      div.appendChild(time);
      div.appendChild(body);
      log.appendChild(div);
    });
  }

  function paintBalance(snap) {
    const el = $("bal");
    el.classList.remove("pulse", "bad");
    if (snap.mode === "auto") {
      const live = snap.liveBalance || {};
      if (!live.ok) {
        el.textContent = "$0.00";
        el.classList.add("pulse", "bad");
        el.title = live.reason === "checking" ? t("checkingBalance") : t("noBalance");
        return;
      }
      el.textContent = `$${money(live.value)}`;
      el.title = "";
      return;
    }
    el.textContent = `$${money(snap.paper.balance)}`;
    el.title = "";
  }

  function renderSnap(snap) {
    if (!snap) return;
    state.snapshot = snap;
    state.running = snap.running;
    state.mode = snap.mode;
    const lamp = $("statusLamp");
    if (lamp) {
      lamp.dataset.status = snap.status;
      lamp.dataset.on = snap.running ? "1" : "0";
      lamp.title = statusLabel(snap.status);
    }
    paintChromePicks(snap);
    paintBalance(snap);
    $("series").textContent = `${snap.risk.step}/${snap.risk.maxSteps} · $${snap.risk.size}`;
    const pnl = Number(snap.todayPnl);
    $("pnl").textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    $("pnl").style.color = pnl >= 0 ? "var(--accent)" : "var(--danger)";
    $("btnRun").textContent = snap.running ? t("stop") : t("start");
    $("btnRun").classList.toggle("stop", snap.running);
    document.querySelectorAll("#modeSeg button").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === snap.mode);
    });
    if (snap.pairLabel && snap.pairLabel !== state.pairLabel) {
      if (state.pairLabel && window.VesperaChart && window.VesperaChart.reset) {
        window.VesperaChart.reset();
      }
      state.pairLabel = snap.pairLabel;
    }
    renderStrategies(snap);
    if (window.VesperaChart) {
      if (window.VesperaChart.setRefreshMs) window.VesperaChart.setRefreshMs(snap.settings?.refreshMs);
      window.VesperaChart.render(snap);
    }
    renderLog(snap);
  }

  function renderStrategies(snap) {
    const host = $("strategyList");
    if (!host) return;
    const list = snap.strategies || [];
    const active = snap.strategyId;
    host.innerHTML = "";
    list.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "strategy-chip";
      btn.dataset.id = s.id;
      btn.textContent = s.name;
      if (s.id === active) btn.classList.add("active");
      if (s.enabled === false) btn.classList.add("soon");
      btn.onclick = async () => {
        if (!window.vespera || s.enabled === false) return;
        const res = await window.vespera.setStrategy(s.id);
        if (res && res.state) renderSnap(res.state);
        if (res && res.ok === false && res.reason === "open_bet") {
          const log = $("log");
          const div = document.createElement("div");
          div.className = "log-row";
          div.textContent = t("strategyBlocked");
          log.prepend(div);
        }
      };
      host.appendChild(btn);
    });
  }

  function closeMenus() {
    document.querySelectorAll(".v-menu.open").forEach((m) => m.classList.remove("open"));
    state.openMenu = null;
  }

  function buildSelect(id, options, value, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "v-select";
    wrap.dataset.id = id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "v-select-btn";
    const current = options.find((o) => o.value === value) || options[0];
    btn.innerHTML = `<span>${current ? current.label : ""}</span><span class="chev">▾</span>`;
    const menu = document.createElement("div");
    menu.className = "v-menu";
    options.forEach((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "v-opt";
      item.textContent = opt.label;
      if (opt.tag) {
        const tag = document.createElement("span");
        tag.className = "v-opt-tag";
        tag.textContent = opt.tag;
        item.appendChild(tag);
      }
      if (opt.dim) item.classList.add("dim");
      if (opt.title) item.title = opt.title;
      if (opt.value === value) item.classList.add("on");
      item.onclick = (e) => {
        e.stopPropagation();
        btn.querySelector("span").textContent = opt.label;
        wrap.dataset.value = opt.value;
        menu.querySelectorAll(".v-opt").forEach((n) => n.classList.remove("on"));
        item.classList.add("on");
        closeMenus();
        if (onChange) onChange(opt.value);
      };
      menu.appendChild(item);
    });
    wrap.dataset.value = current ? current.value : "";
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = menu.classList.contains("open");
      closeMenus();
      if (!open) {
        menu.classList.add("open");
        state.openMenu = wrap;
      }
    };
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  function helpBtn(hintKey) {
    const tip = String(t(hintKey) || "").replace(/"/g, "&quot;");
    return `<button type="button" class="help" data-tip="${tip}" aria-label="${tip}">?</button>`;
  }

  function hideTip() {
    const el = $("vspTip");
    if (el) el.hidden = true;
  }

  function showTip(btn) {
    const el = $("vspTip");
    if (!el || !btn) return;
    const text = btn.getAttribute("data-tip") || "";
    if (!text) return;
    el.textContent = text;
    el.hidden = false;
    const r = btn.getBoundingClientRect();
    const pad = 10;
    const tw = Math.min(320, window.innerWidth - 24);
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    el.style.width = `${tw}px`;
    el.style.left = `${left}px`;
    el.style.top = "0px";
    const h = el.offsetHeight || 48;
    let top = r.top - h - 8;
    if (top < pad) top = r.bottom + 8;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
    el.style.top = `${top}px`;
  }

  function closePanel() {
    $("panel").hidden = true;
    $("backdrop").hidden = true;
    const foot = $("panelFoot");
    if (foot) {
      foot.hidden = true;
      foot.innerHTML = "";
    }
    closeMenus();
  }

  function debounceSave(patch, ms = 80) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      if (!window.vespera) return;
      const snap = await window.vespera.saveSettings(patch);
      if (!snap || !snap.settings) return;
      state.snapshot = snap;
      if (window.VesperaChart && window.VesperaChart.setRefreshMs) {
        window.VesperaChart.setRefreshMs(snap.settings.refreshMs);
      }
      if (
        patch.minCrossTicks != null ||
        patch.minOpeningAtr != null ||
        patch.confirmCount != null ||
        patch.fullBodyOnS != null ||
        patch.fastPeriod != null ||
        patch.slowPeriod != null
      ) {
        renderSnap(snap);
      }
    }, ms);
  }

  function paintChromePicks(snap) {
    const hostSym = $("hdrSym");
    const hostTf = $("hdrTf");
    if (!hostSym || !hostTf || !snap) return;
    const s = snap.settings || {};
    const auto = snap.mode === "auto";
    const pmTfs = snap.polymarketTimeframes || ["5m", "15m"];
    // Auto lists only what Polymarket has rounds for; Paper lists everything,
    // Polymarket pairs first, the rest dimmed (no real quote, priced at 0.50).
    const rows = (snap.symbols || []).filter((x) => !auto || x.polymarket);
    const ordered = auto ? rows : [...rows.filter((x) => x.polymarket), ...rows.filter((x) => !x.polymarket)];
    const symbols = ordered.map((x) => ({
      value: x.id,
      label: x.label,
      tag: !auto && x.polymarket ? "P" : "",
      dim: !x.polymarket,
      title: x.polymarket ? t("pmRound") : t("pmNoRound"),
    }));
    const tfs = (snap.timeframes || ["1m", "5m", "15m", "1h", "4h", "1d"])
      .filter((tf) => !auto || pmTfs.includes(tf))
      .map((tf) => ({
        value: tf,
        label: tf,
        tag: !auto && pmTfs.includes(tf) ? "P" : "",
        dim: !pmTfs.includes(tf),
        title: pmTfs.includes(tf) ? t("pmRound") : t("pmNoRound"),
      }));
    const key = `${s.symbol || ""}|${s.timeframe || ""}|${symbols.length}|${tfs.length}|${state.locale}|${snap.mode}`;
    if (state.chromeKey === key && hostSym.firstChild && hostTf.firstChild) return;
    state.chromeKey = key;
    hostSym.innerHTML = "";
    hostTf.innerHTML = "";
    const onMarket = async (patch) => {
      if (!window.vespera) return;
      const next = await window.vespera.saveSettings(patch);
      if (next && next.settings) renderSnap(next);
    };
    hostSym.appendChild(
      buildSelect("hdr-sym", symbols.length ? symbols : [{ value: "BTCUSDT", label: "BTC/USDT" }], s.symbol || "BTCUSDT", (v) =>
        onMarket({ symbol: v })
      )
    );
    hostTf.appendChild(buildSelect("hdr-tf", tfs, s.timeframe || "15m", (v) => onMarket({ timeframe: v })));
  }

  function openSheet(show) {
    $("sheet").hidden = !show;
    $("backdrop").hidden = !show;
  }

  function openPanel(kind) {
    const body = $("panelBody");
    const title = $("panelTitle");
    const foot = $("panelFoot");
    $("panel").hidden = false;
    $("backdrop").hidden = false;
    if (foot) {
      foot.hidden = true;
      foot.innerHTML = "";
    }
    closeMenus();

    if (kind === "api") {
      title.textContent = t("api");
      const ping = state.snapshot?.ping;
      body.innerHTML = `
        <p class="hint">${t("pingHint")}</p>
        <div class="field">
          <label>${t("api")}</label>
          <div class="api-row">
            <img class="api-mark" src="assets/polymarket.png" width="22" height="22" alt="Polymarket" />
            <input id="apiKey" type="password" placeholder="${t("apiPlaceholder")}" autocomplete="off" />
          </div>
        </div>
        <div class="field">
          <label>${t("apiSecret")}</label>
          <input id="apiSecret" type="password" placeholder="${t("apiSecretPlaceholder")}" autocomplete="off" />
        </div>
        <div class="field">
          <label>${t("apiPassphrase")}</label>
          <input id="apiPassphrase" type="password" placeholder="${t("apiPassphrasePlaceholder")}" autocomplete="off" />
        </div>
        <div class="field">
          <label>${t("walletAddress")}</label>
          <input id="walletAddress" type="text" placeholder="${t("walletPlaceholder")}" autocomplete="off" />
        </div>
        <div class="field">
          <label>${t("walletType")}</label>
          <select id="walletType">
            <option value="AUTO">${t("walletTypeAuto")}</option>
            <option value="DEPOSIT_WALLET">${t("walletTypeDeposit")}</option>
            <option value="POLY_PROXY">${t("walletTypeProxy")}</option>
            <option value="POLY_GNOSIS_SAFE">${t("walletTypeSafe")}</option>
            <option value="EOA">EOA</option>
          </select>
          <p class="hint" id="walletTypeHint"></p>
        </div>
        <div class="field">
          <label>${t("privateKey")}</label>
          <input id="privateKey" type="password" placeholder="${t("privateKeyPlaceholder")}" autocomplete="off" />
        </div>
        <div class="field">
          <label>${t("proxyUrl")}</label>
          <input id="proxyUrl" type="text" placeholder="${t("proxyPlaceholder")}" autocomplete="off" />
        </div>
        <button class="ok" id="btnDerive">${t("deriveKeys")}</button>
        <p class="hint" id="deriveOut"></p>
        <button class="ok" id="btnPing">${t("ping")}</button>
        <p class="hint" id="pingOut"></p>
        <p class="hint">${t("autoBlocked")}</p>
      `;
      const sApi = state.snapshot?.settings || {};
      if (sApi.walletAddress) $("walletAddress").value = sApi.walletAddress;
      // Stored secrets are never sent back to the renderer. Show that they exist
      // and keep them when the field is left empty.
      const storedHint = t("secretStored");
      if (sApi.hasApiKey) $("apiKey").placeholder = storedHint;
      if (sApi.hasApiSecret) $("apiSecret").placeholder = storedHint;
      if (sApi.hasApiPassphrase) $("apiPassphrase").placeholder = storedHint;
      if (sApi.hasPrivKey) $("privateKey").placeholder = storedHint;
      if (sApi.proxyUrl) $("proxyUrl").value = sApi.proxyUrl;
      $("walletType").value = sApi.walletType || "AUTO";
      const paintWalletType = (resolved) => {
        const r = resolved || sApi.resolvedWalletType;
        $("walletTypeHint").textContent =
          $("walletType").value === "AUTO" && r ? `${t("walletTypeDetected")}: ${r}` : "";
      };
      paintWalletType();
      $("walletType").onchange = () => paintWalletType();
      $("btnDerive").onclick = async () => {
        const out = $("deriveOut");
        out.textContent = t("deriveWorking");
        let res;
        try {
          res = await window.vespera.deriveKeys({
            privateKey: $("privateKey").value.trim(),
            walletAddress: $("walletAddress").value.trim(),
            walletType: $("walletType").value,
            proxyUrl: $("proxyUrl").value.trim(),
          });
        } catch (err) {
          res = { ok: false, reason: String((err && err.message) || err) };
        }
        if (res && res.ok) {
          out.innerHTML = `<span class="ping-dot ok"></span>${t("deriveOk")} \u00b7 ${esc(res.walletType)} \u00b7 ${esc(
            String(res.signerAddress || "").slice(0, 10)
          )}\u2026`;
          paintWalletType(res.walletType);
          $("privateKey").placeholder = t("secretStored");
          $("privateKey").value = "";
          const snap = await window.vespera.snapshot();
          if (snap) state.snapshot = snap;
        } else {
          out.innerHTML = `<span class="ping-dot bad"></span>${t("deriveFail")}: ${esc(
            (res && res.reason) || "error"
          )}`;
        }
      };
      $("btnPing").onclick = async () => {
        const creds = {
          apiKey: $("apiKey").value.trim(),
          apiSecret: $("apiSecret").value.trim(),
          apiPassphrase: $("apiPassphrase").value.trim(),
          walletAddress: $("walletAddress").value.trim(),
          privateKey: $("privateKey").value.trim(),
          walletType: $("walletType").value,
          proxyUrl: $("proxyUrl").value.trim(),
        };
        $("pingOut").textContent = t("pinging");
        let res;
        try {
          res = await window.vespera.ping(creds);
        } catch (err) {
          res = { live: { ok: false, message: String((err && err.message) || err) } };
        }
        const live = res.live || {};
        const l2Failed = live.l2Ok === false;
        const ok = Boolean(live.ok) && !l2Failed;
        const extra = live.slug ? ` · ${esc(live.slug)}` : "";
        const q = live.quotes || {};
        const fmt = (side) =>
          q[side] ? `${side} ${q[side].price.toFixed(2)} → ×${q[side].payout.toFixed(2)}` : "";
        const quoteLine = q.UP || q.DOWN
          ? `<br/><span class="hint">${[fmt("UP"), fmt("DOWN")].filter(Boolean).join(" · ")}${
              q.minOrderSize ? ` · min ${q.minOrderSize}` : ""
            }</span>`
          : "";
        const l2 = live.hasSigner ? (l2Failed ? ` · ${t("l2Fail")}` : ` · ${t("l2Ok")}`) : "";
        $("pingOut").innerHTML = `<span class="ping-dot ${ok ? "ok" : "bad"}"></span>${
          l2Failed
            ? t("l2Rejected")
            : live.ok
              ? t("reachable")
              : live.blocked
                ? `${t("geoBlocked")}${live.geo && live.geo.country ? " \u00b7 " + esc(live.geo.country) : ""}`
                : live.message === "missing_key"
                  ? t("missingKey")
                  : `${t("unreachable")}${live.message ? " \u00b7 " + esc(live.message) : ""}`
        }${live.latencyMs ? " · " + live.latencyMs + "ms" : ""}${extra}${l2}${quoteLine}`;
        if (res && res.live) {
          const snap = await window.vespera.snapshot();
          if (snap) state.snapshot = snap;
        }
      };
      if (ping?.live) $("pingOut").textContent = ping.live.message || ping.live.slug || "";
    }

    if (kind === "theme") {
      title.textContent = t("theme");
      body.innerHTML = `<div class="field"><label>${t("theme")}</label><div class="seg" id="themeSeg">
        <button data-theme="glass-dark">${t("glassDark")}</button>
        <button data-theme="glass-light">${t("glassLight")}</button>
      </div></div>`;
      document.querySelectorAll("#themeSeg button").forEach((b) => {
        b.classList.toggle("on", b.dataset.theme === state.theme);
        b.onclick = async () => {
          state.theme = b.dataset.theme;
          applyTheme();
          document.querySelectorAll("#themeSeg button").forEach((x) =>
            x.classList.toggle("on", x.dataset.theme === state.theme)
          );
          if (window.vespera) await window.vespera.saveSettings({ theme: state.theme });
        };
      });
    }

    if (kind === "language") {
      title.textContent = t("language");
      body.innerHTML = `<div class="field"><label>${t("language")}</label><div class="seg" id="langSeg">
        <button data-lang="en">English</button>
        <button data-lang="ru">Русский</button>
      </div></div>`;
      document.querySelectorAll("#langSeg button").forEach((b) => {
        b.classList.toggle("on", b.dataset.lang === state.locale);
        b.onclick = async () => {
          state.locale = b.dataset.lang;
          applyI18n();
          document.querySelectorAll("#langSeg button").forEach((x) =>
            x.classList.toggle("on", x.dataset.lang === state.locale)
          );
          if (window.vespera) await window.vespera.saveSettings({ locale: state.locale });
          renderSnap(state.snapshot);
        };
      });
    }

    if (kind === "settings") {
      title.textContent = t("settings");
      const s = state.snapshot?.settings || {};
      body.innerHTML = `
        <div class="field"><span class="field-label">${t("base")}</span><input id="base" value="${s.baseUsd || "1.00"}" /></div>
        <div class="field"><span class="field-label">${t("maxSteps")}</span><input id="steps" value="${s.maxSteps || 6}" /></div>
        <div class="field">
          <span class="field-label">${t("minOpening")}${helpBtn("minOpeningHint")}</span>
          <div class="range-row">
            <input id="opening" type="range" min="0" max="40" step="1" />
            <span class="range-val" id="openingVal">0.00 ATR</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("minCross")}${helpBtn("minCrossHint")}</span>
          <div class="range-row">
            <input id="crossTicks" type="range" min="0" max="2000" step="1" />
            <span class="range-val" id="crossVal">0 ${plural(0, t("minCrossUnit"))}</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("confirmCount")}${helpBtn("confirmCountHint")}</span>
          <div class="range-row">
            <input id="confirms" type="range" min="0" max="10" step="1" />
            <span class="range-val" id="confirmsVal">0</span>
          </div>
        </div>
        <div class="field toggle-row">
          <span class="field-label">${t("maType")}${helpBtn("maTypeHint")}</span>
          <div class="seg seg-sm" id="maTypeSeg">
            <button type="button" data-ma="SMA" class="${(s.maType || "SMA") === "SMA" ? "on" : ""}">SMA</button>
            <button type="button" data-ma="EMA" class="${(s.maType || "SMA") === "EMA" ? "on" : ""}">EMA</button>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("fastPeriod")}${helpBtn("fastPeriodHint")}</span>
          <div class="range-row">
            <input id="fastPeriod" type="range" min="2" max="80" step="1" />
            <span class="range-val" id="fastPeriodVal">SMA20</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("slowPeriod")}${helpBtn("slowPeriodHint")}</span>
          <div class="range-row">
            <input id="slowPeriod" type="range" min="20" max="400" step="1" />
            <span class="range-val" id="slowPeriodVal">SMA200</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("refresh")}${helpBtn("refreshHint")}</span>
          <div class="range-row">
            <input id="refresh" type="range" min="1" max="1000" step="1" />
            <span class="range-val" id="refreshVal">100 ${t("refreshUnit")}</span>
          </div>
        </div>
        <div class="field toggle-row">
          <span class="field-label">${t("fullBodyOnS")}${helpBtn("fullBodyOnSHint")}</span>
          <button type="button" class="toggle ${s.fullBodyOnS ? "on" : ""}" id="fullBodyToggle" aria-pressed="${Boolean(s.fullBodyOnS)}">
            <span class="knob"></span>
          </button>
        </div>
        <div class="field toggle-row">
          <span class="field-label">${t("notify")}${helpBtn("notifyHint")}</span>
          <button type="button" class="toggle ${s.notificationsEnabled !== false ? "on" : ""}" id="notifyToggle" aria-pressed="${s.notificationsEnabled !== false}">
            <span class="knob"></span>
          </button>
        </div>
      `;
      if (foot) {
        foot.hidden = false;
        foot.innerHTML = `
          <button type="button" class="ok" id="saveSet">${t("save")}</button>
          <button type="button" class="ghost" id="resetPaper">${t("resetPaper")}</button>
        `;
      }
      const opening = Math.round(Number(s.minOpeningAtr || 0) * 20);
      $("opening").value = String(opening);
      const paintOpening = () => {
        $("openingVal").textContent = `${(Number($("opening").value) / 20).toFixed(2)} ATR`;
      };
      paintOpening();
      $("opening").oninput = () => {
        paintOpening();
        debounceSave({ minOpeningAtr: Number($("opening").value) / 20 });
      };
      const tickSize = Number(s.tickSize) > 0 ? Number(s.tickSize) : 0.01;
      const crossMax = tickSize >= 0.01 ? 2000 : tickSize >= 0.001 ? 500 : 200;
      $("crossTicks").max = String(crossMax);
      $("crossTicks").value = String(Math.max(0, Math.min(crossMax, Number(s.minCrossTicks || 0))));
      const paintCross = () => {
        const n = Number($("crossTicks").value) || 0;
        const usd = n * tickSize;
        const usdLabel =
          usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(4) : usd.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
        $("crossVal").textContent =
          n === 0 ? `0 ${plural(0, t("minCrossUnit"))}` : `${n} ${plural(n, t("minCrossUnit"))} · $${usdLabel}`;
      };
      paintCross();
      $("crossTicks").oninput = () => {
        paintCross();
        debounceSave({ minCrossTicks: Number($("crossTicks").value) });
      };
      $("confirms").value = String(Math.max(0, Math.min(10, Number(s.confirmCount || 0))));
      const paintConfirms = () => {
        const n = Number($("confirms").value) || 0;
        $("confirmsVal").textContent = `${n} ${plural(n, t("confirmCountUnit"))}`;
      };
      paintConfirms();
      $("confirms").oninput = () => {
        paintConfirms();
        debounceSave({ confirmCount: Number($("confirms").value) });
      };
      const currentMaType = () => {
        const on = document.querySelector("#maTypeSeg button.on");
        return on ? on.dataset.ma : (s.maType || "SMA");
      };
      $("fastPeriod").value = String(Math.max(2, Math.min(80, Number(s.fastPeriod || 20))));
      $("slowPeriod").value = String(Math.max(20, Math.min(400, Number(s.slowPeriod || 200))));
      const paintPeriods = () => {
        let fast = Number($("fastPeriod").value) || 20;
        let slow = Number($("slowPeriod").value) || 200;
        if (slow <= fast) {
          slow = Math.min(400, fast + 1);
          $("slowPeriod").value = String(slow);
        }
        const maLabel = currentMaType();
        $("fastPeriodVal").textContent = `${maLabel}${fast}`;
        $("slowPeriodVal").textContent = `${maLabel}${slow}`;
      };
      paintPeriods();
      $("fastPeriod").oninput = () => {
        paintPeriods();
        debounceSave({
          fastPeriod: Number($("fastPeriod").value),
          slowPeriod: Number($("slowPeriod").value),
        });
      };
      $("slowPeriod").oninput = () => {
        paintPeriods();
        debounceSave({
          fastPeriod: Number($("fastPeriod").value),
          slowPeriod: Number($("slowPeriod").value),
        });
      };
      $("refresh").value = String(s.refreshMs || 100);
      const paintRefresh = () => {
        $("refreshVal").textContent = `${$("refresh").value} ${t("refreshUnit")}`;
      };
      paintRefresh();
      $("refresh").oninput = () => {
        paintRefresh();
        const ms = Number($("refresh").value);
        if (window.VesperaChart && window.VesperaChart.setRefreshMs) window.VesperaChart.setRefreshMs(ms);
        debounceSave({ refreshMs: ms });
      };
      const fullBodyBtn = $("fullBodyToggle");
      fullBodyBtn.onclick = async () => {
        const on = !fullBodyBtn.classList.contains("on");
        fullBodyBtn.classList.toggle("on", on);
        fullBodyBtn.setAttribute("aria-pressed", String(on));
        debounceSave({ fullBodyOnS: on });
      };
      const maSeg = $("maTypeSeg");
      if (maSeg) maSeg.onclick = (e) => {
        const btn = e.target.closest("button[data-ma]");
        if (!btn) return;
        for (const b of maSeg.querySelectorAll("button")) b.classList.toggle("on", b === btn);
        paintPeriods();
        debounceSave({ maType: btn.dataset.ma });
      };
      const notifyBtn = $("notifyToggle");
      notifyBtn.onclick = async () => {
        const on = !notifyBtn.classList.contains("on");
        notifyBtn.classList.toggle("on", on);
        notifyBtn.setAttribute("aria-pressed", String(on));
        if (window.vespera) await window.vespera.saveSettings({ notificationsEnabled: on });
      };
      const saveNow = async () => {
        if (state.savingPanel) return;
        state.savingPanel = true;
        const baseEl = $("base");
        const stepsEl = $("steps");
        const openingEl = $("opening");
        const crossEl = $("crossTicks");
        const confirmsEl = $("confirms");
        const fastEl = $("fastPeriod");
        const slowEl = $("slowPeriod");
        const refreshEl = $("refresh");
        const notifyEl = $("notifyToggle");
        const fullBodyEl = $("fullBodyToggle");
        const patch = {
          maxSteps: Number(stepsEl && stepsEl.value) || 6,
          baseUsd: baseEl ? baseEl.value : s.baseUsd || "1.00",
          minOpeningAtr: openingEl ? Number(openingEl.value) / 20 : 0,
          minCrossTicks: crossEl ? Number(crossEl.value) : 0,
          confirmCount: confirmsEl ? Number(confirmsEl.value) : 0,
          fastPeriod: fastEl ? Number(fastEl.value) : 20,
          slowPeriod: slowEl ? Number(slowEl.value) : 200,
          fullBodyOnS: fullBodyEl ? fullBodyEl.classList.contains("on") : false,
          maType: (document.querySelector("#maTypeSeg button.on") || {}).dataset?.ma || s.maType || "SMA",
          refreshMs: refreshEl ? Number(refreshEl.value) : 100,
          notificationsEnabled: notifyEl ? notifyEl.classList.contains("on") : true,
        };
        hideTip();
        closePanel();
        try {
          if (!window.vespera) return;
          const snap = await window.vespera.saveSettings(patch);
          try {
            await window.vespera.confirmLot(patch.baseUsd);
          } catch {
            /* lot confirm is secondary */
          }
          renderSnap(snap || (await window.vespera.snapshot()));
        } catch {
          try {
            renderSnap(await window.vespera.snapshot());
          } catch {
            /* already closed */
          }
        } finally {
          state.savingPanel = false;
        }
      };
      if (foot) {
        foot.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const hit = e.target.closest("button");
          if (!hit) return;
          if (hit.id === "saveSet") saveNow();
        };
      }
      $("resetPaper").onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.vespera || !window.vespera.resetPaper) return;
        const snap = await window.vespera.resetPaper(s.paperBalance || "1000.00");
        renderSnap(snap);
      };
      const saveBtn = $("saveSet");
      if (saveBtn) saveBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveNow();
      };
    }

    if (kind === "stats") {
      title.textContent = t("stats");
      const r = state.snapshot?.risk || {};
      body.innerHTML = `
        <p class="hint">${t("statsHint")}</p>
        <p>${t("series")}: ${r.step}/${r.maxSteps}</p>
        <p>${t("today")}: $${state.snapshot?.todayPnl}</p>
        <p>${t("balance")}: $${state.snapshot?.paper?.balance}</p>
      `;
    }

    if (kind === "journal") {
      title.textContent = t("journal");
      const rows = (state.snapshot?.log || []).slice(0, 40);
      body.innerHTML =
        `<p class="hint">${t("journalHint")}</p>` +
        (rows
          .map((row) => {
            const line = logLine(row);
            return `<div class="hint journal-line"><span class="log-time">${line.when}</span> ${line.title}${
              line.detail ? " · " + line.detail : ""
            }</div>`;
          })
          .join("") || `<p class="hint">${t("logEmpty")}</p>`);
    }
  }

  async function boot() {
    if (window.vespera) {
      const settings = await window.vespera.getSettings();
      state.locale = settings.locale || "en";
      state.theme = settings.theme || "glass-dark";
      applyTheme();
      applyI18n();
      if (window.vespera.warmChart) {
        try {
          renderSnap(await window.vespera.warmChart());
        } catch {
          renderSnap(await window.vespera.snapshot());
        }
      } else {
        renderSnap(await window.vespera.snapshot());
      }
      window.vespera.onEvent((evt) => {
        if (evt.type === "tick" && evt.payload && window.VesperaChart) {
          window.VesperaChart.updateForming(evt.payload.forming);
          return;
        }
        if (evt.type === "notify" && evt.payload) {
          const log = $("log");
          if (log) {
            const div = document.createElement("div");
            div.className = `log-row log-notify log-${evt.payload.kind || "setup"}`;
            const time = document.createElement("span");
            time.className = "log-time";
            time.textContent = new Date(evt.payload.at || Date.now()).toISOString().slice(11, 19);
            const body = document.createElement("span");
            body.className = "log-body";
            body.textContent = [evt.payload.title, evt.payload.body].filter(Boolean).join(" · ");
            div.appendChild(time);
            div.appendChild(body);
            log.prepend(div);
          }
        }
        if (evt.state) renderSnap(evt.state);
      });
    } else {
      applyI18n();
    }
    if (navigator.userAgent.includes("Windows")) document.body.classList.add("win");
    if (navigator.userAgent.includes("Mac")) document.body.classList.add("mac");

    $("btnMenu").onclick = () => openSheet(true);
    $("sheetClose").onclick = () => openSheet(false);
    $("backdrop").onclick = () => {
      openSheet(false);
      closePanel();
    };
    $("panelClose").onclick = () => closePanel();
    document.querySelectorAll("[data-open]").forEach((btn) => {
      btn.onclick = () => {
        openSheet(false);
        openPanel(btn.dataset.open);
      };
    });
    document.querySelectorAll(".rail-item").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".rail-item").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        if (btn.dataset.panel === "chart") {
          closePanel();
        } else {
          openPanel(btn.dataset.panel);
        }
      };
    });
    document.querySelectorAll("#modeSeg button").forEach((btn) => {
      btn.onclick = async () => {
        if (window.vespera) {
          const snap = await window.vespera.setMode(btn.dataset.mode);
          renderSnap(snap);
        } else {
          state.mode = btn.dataset.mode;
          document.querySelectorAll("#modeSeg button").forEach((b) =>
            b.classList.toggle("on", b.dataset.mode === state.mode)
          );
        }
      };
    });
    $("btnRun").onclick = async () => {
      if (!window.vespera) return;
      if (state.running) await window.vespera.stop();
      else await window.vespera.start();
      renderSnap(await window.vespera.snapshot());
    };
    $("btnMin").onclick = () => window.vespera?.minimize();
    $("btnMax").onclick = () => window.vespera?.maximize();
    $("btnClose").onclick = () => window.vespera?.close();
    const goLive = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (window.VesperaChart && window.VesperaChart.goToLive) window.VesperaChart.goToLive();
    };
    $("btnLive").onclick = goLive;
    document.addEventListener("click", () => closeMenus());
    document.addEventListener("mouseover", (e) => {
      const btn = e.target.closest && e.target.closest(".help");
      if (btn) showTip(btn);
    });
    document.addEventListener("mouseout", (e) => {
      const btn = e.target.closest && e.target.closest(".help");
      if (!btn) return;
      const next = e.relatedTarget;
      if (next && btn.contains(next)) return;
      hideTip();
    });
    document.addEventListener("scroll", hideTip, true);
  }

  boot();
})();
