(() => {
  const $ = (id) => document.getElementById(id);
  const t = (key) => (window.VSP_I18N[state.locale] || window.VSP_I18N.en)[key] || key;

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
      if (window.VesperaChart && window.VesperaChart.reset) window.VesperaChart.reset();
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
    }, ms);
  }

  function paintChromePicks(snap) {
    const hostSym = $("hdrSym");
    const hostTf = $("hdrTf");
    if (!hostSym || !hostTf || !snap) return;
    const s = snap.settings || {};
    const symbols = (snap.symbols || []).map((x) => ({ value: x.id, label: x.label }));
    const tfs = (snap.timeframes || ["1m", "5m", "15m", "1h", "4h", "1d"]).map((tf) => ({
      value: tf,
      label: tf,
    }));
    const key = `${s.symbol || ""}|${s.timeframe || ""}|${symbols.length}|${tfs.length}|${state.locale}`;
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
          <input id="apiKey" type="password" placeholder="${t("apiPlaceholder")}" />
        </div>
        <button class="ok" id="btnPing">${t("ping")}</button>
        <p class="hint" id="pingOut"></p>
        <p class="hint">${t("autoBlocked")}</p>
      `;
      $("btnPing").onclick = async () => {
        const key = $("apiKey").value.trim();
        const res = await window.vespera.ping(key);
        const live = res.live || {};
        const ok = Boolean(live.ok);
        $("pingOut").innerHTML = `<span class="ping-dot ${ok ? "ok" : "bad"}"></span>${
          ok ? t("reachable") : live.message === "missing_key" ? t("missingKey") : t("unreachable")
        }${live.latencyMs ? " · " + live.latencyMs + "ms" : ""}`;
      };
      if (ping?.live) $("pingOut").textContent = ping.live.message || "";
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
            <input id="crossTicks" type="range" min="0" max="50" step="1" />
            <span class="range-val" id="crossVal">0 ${t("minCrossUnit")}</span>
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
      $("crossTicks").value = String(Math.max(0, Number(s.minCrossTicks || 0)));
      const paintCross = () => {
        $("crossVal").textContent = `${$("crossTicks").value} ${t("minCrossUnit")}`;
      };
      paintCross();
      $("crossTicks").oninput = () => {
        paintCross();
        debounceSave({ minCrossTicks: Number($("crossTicks").value) });
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
        const refreshEl = $("refresh");
        const notifyEl = $("notifyToggle");
        const patch = {
          maxSteps: Number(stepsEl && stepsEl.value) || 6,
          baseUsd: baseEl ? baseEl.value : s.baseUsd || "1.00",
          minOpeningAtr: openingEl ? Number(openingEl.value) / 20 : 0,
          minCrossTicks: crossEl ? Number(crossEl.value) : 0,
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
