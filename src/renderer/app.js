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
    queuedSettingsPatch: {},
    settingsSaveQueue: Promise.resolve(),
    savingPanel: false,
    depositTimer: 0,
    telegramTimer: 0,
    telegramDraftDirty: false,
    execution: null,
    executionBusy: false,
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

  const THEMES = ["glass-dark", "glass-light", "glass-blue"];

  function applyTheme() {
    if (!THEMES.includes(state.theme)) state.theme = "glass-dark";
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
        paused: t("paused"),
        daily_limit: t("dailyLimitHit"),
      }[status] || status
    );
  }

  function executionErrorText(error, message) {
    const code = typeof error === "string" ? error : error?.code || error?.reason;
    const key = `executionError_${code || ""}`;
    if (code && t(key) !== key) return t(key);
    return message || (typeof error === "object" && error?.message) || t("executionOfflineHint");
  }

  function executionState() {
    return state.execution || state.snapshot?.execution || null;
  }

  function executionUnavailable(execution = executionState()) {
    return Boolean(execution && ((execution.mode === "server" && !execution.connected) || execution.blocked));
  }

  function executionLabel(execution = executionState()) {
    if (!execution || execution.mode === "local") return t("executionLocal");
    return execution.connected ? t("executionServer") : t("executionOffline");
  }

  function paintExecution(execution = executionState()) {
    if (!execution) return;
    state.execution = execution;
    const badge = $("executionBadge");
    const badgeText = $("executionBadgeText");
    const telegramRuntime = $("telegramRuntimeHint");
    if (telegramRuntime) telegramRuntime.textContent = execution.mode === "server" ? t("telegramRuntimeServer") : t("telegramRuntimeLocal");
    const mode = execution.mode === "server" ? (execution.connected ? "server" : "offline") : "local";
    if (badge) {
      badge.dataset.mode = mode;
      badge.title = execution.error ? executionErrorText(execution.error, "") :
        mode === "server" ? t("executionServerHint") : mode === "offline" ? t("executionOfflineHint") : t("executionLocalHint");
    }
    if (badgeText) badgeText.textContent = executionLabel(execution);
    const staleBanner = $("executionStaleBanner");
    if (staleBanner) staleBanner.hidden = !(execution.mode === "server" && !execution.connected && Boolean(state.snapshot));
    const section = $("executionSection");
    if (section) {
      const url = $("executionUrl");
      const token = $("executionToken");
      const button = $("executionConnect");
      const retry = $("executionRetry");
      const toggle = $("zeroModeToggle");
      const output = $("executionMessage");
      const serverActive = execution.mode === "server";
      const locked = serverActive || state.executionBusy || execution.switching;
      if (url) {
        if (document.activeElement !== url && execution.url) url.value = execution.url;
        url.disabled = locked;
      }
      if (token) {
        if (!token.value) token.placeholder = execution.hasToken ? t("serverTokenSaved") : "";
        token.disabled = state.executionBusy || Boolean(execution.switching) || Boolean(execution.pendingTarget);
      }
      if (button) {
        button.disabled = state.executionBusy || Boolean(execution.switching);
        button.textContent = t("serverConnectSave");
      }
      if (retry) {
        retry.hidden = !execution.pendingTarget;
        retry.disabled = state.executionBusy || Boolean(execution.switching);
      }
      if (toggle) {
        toggle.classList.toggle("on", serverActive);
        toggle.setAttribute("aria-pressed", String(serverActive));
        toggle.disabled = state.executionBusy || Boolean(execution.switching) || (serverActive && !execution.connected);
      }
      const hint = $("executionStatusHint");
      if (hint) {
        const offline = execution.mode === "server" && !execution.connected;
        hint.textContent = execution.error ? executionErrorText(execution.error, "") :
          offline ? t("executionOfflineHint") : serverActive ? t("executionServerHint") : t("executionLocalHint");
        hint.classList.toggle("warn", offline || Boolean(execution.error));
      }
      const routeHint = $("executionRouteHint");
      if (routeHint) routeHint.hidden = !serverActive;
      if (output && (!output.dataset.manual || !execution.connected)) {
        output.hidden = true;
        output.textContent = "";
        delete output.dataset.manual;
      }
    }
    const unavailable = executionUnavailable(execution);
    const lamp = $("statusLamp");
    if (lamp && state.snapshot) {
      lamp.dataset.status = unavailable ? "paused" : state.snapshot.status;
      if (unavailable) lamp.title = t("executionOfflineHint");
    }
    const run = $("btnRun");
    if (run) {
      run.disabled = unavailable || state.executionBusy;
      run.title = unavailable ? t("executionOfflineHint") : "";
    }
    document.querySelectorAll("#modeSeg button, #strategyList button").forEach((button) => {
      button.disabled = unavailable || state.executionBusy;
    });
    document.querySelectorAll("#chromePicks button").forEach((button) => {
      button.disabled = unavailable || state.executionBusy;
    });
    updateSettingsLockUi(state.snapshot);
  }

  function executionResult(reply) {
    if (reply && reply.execution) state.execution = reply.execution;
    else if (reply && reply.mode && typeof reply.connected === "boolean") state.execution = reply;
    if (reply && reply.state) renderSnap(reply.state);
    else paintExecution();
    return reply;
  }

  function validExecutionUrl(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      const loopback = ["127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash && ["", "/"].includes(parsed.pathname) &&
        (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
    } catch {
      return false;
    }
  }

  function showExecutionMessage(message, isError = false) {
    const output = $("executionMessage");
    if (!output) return;
    output.textContent = message;
    output.hidden = false;
    output.dataset.manual = "1";
    output.classList.toggle("warn", isError);
  }

  async function configureExecution() {
    if (executionState()?.mode === "server" && !$("executionToken")?.value) {
      if (!window.vespera?.getExecution) return;
      state.executionBusy = true;
      paintExecution();
      showExecutionMessage(t("executionChecking"));
      try {
        const execution = await window.vespera.getExecution();
        state.execution = execution;
        showExecutionMessage(execution.error ? executionErrorText(execution.error) : execution.connected ? t("executionServerHint") : t("executionOfflineHint"), Boolean(execution.error) || !execution.connected);
      } catch (error) {
        showExecutionMessage(executionErrorText(error), true);
      } finally {
        state.executionBusy = false;
        paintExecution();
      }
      return;
    }
    if (!window.vespera?.configureExecution) {
      showExecutionMessage(t("executionOfflineHint"), true);
      return;
    }
    const url = $("executionUrl").value.trim();
    const token = $("executionToken").value;
    if (!validExecutionUrl(url)) {
      showExecutionMessage(t("executionInvalidUrl"), true);
      $("executionUrl").focus();
      return;
    }
    state.executionBusy = true;
    paintExecution();
    showExecutionMessage(t("executionChecking"));
    try {
      const reply = executionResult(await window.vespera.configureExecution({ url, token }));
      $("executionToken").value = "";
      if (reply?.ok === false) {
        showExecutionMessage(executionErrorText(reply.reason, reply.message), true);
      } else {
        showExecutionMessage(executionState()?.connected ? t("executionServerHint") : t("executionOfflineHint"), !executionState()?.connected);
      }
    } catch (error) {
      showExecutionMessage(executionErrorText(error?.code, error?.message), true);
    } finally {
      $("executionToken").value = "";
      state.executionBusy = false;
      paintExecution();
    }
  }

  async function switchExecutionMode(mode) {
    const execution = executionState() || { mode: "local" };
    if (mode === execution.mode || state.executionBusy) return;
    if (mode === "server" && !execution.configured) {
      showExecutionMessage(t("executionInvalidUrl"), true);
      return;
    }
    const confirmation = mode === "server" ? t("executionSwitchServerConfirm") : t("executionSwitchLocalConfirm");
    if (!window.confirm(confirmation)) return;
    if (!window.vespera?.setExecutionMode) {
      showExecutionMessage(t("executionOfflineHint"), true);
      return;
    }
    state.executionBusy = true;
    paintExecution();
    showExecutionMessage(t("executionBusy"));
    try {
      const reply = executionResult(await window.vespera.setExecutionMode(mode));
      if (!reply || reply.ok === false) {
        showExecutionMessage(executionErrorText(reply?.reason, reply?.message), true);
      } else {
        showExecutionMessage(mode === "server" ? t("executionServerHint") : t("executionLocalHint"));
      }
    } catch (error) {
      showExecutionMessage(executionErrorText(error?.code, error?.message), true);
    } finally {
      state.executionBusy = false;
      paintExecution();
    }
  }

  async function retryExecutionTransfer() {
    const target = executionState()?.pendingTarget;
    if (!target || state.executionBusy || !window.vespera?.setExecutionMode) return;
    state.executionBusy = true;
    paintExecution();
    showExecutionMessage(t("executionBusy"));
    try {
      const reply = executionResult(await window.vespera.setExecutionMode(target));
      if (!reply || reply.ok === false) showExecutionMessage(executionErrorText(reply?.reason, reply?.message), true);
      else showExecutionMessage(target === "server" ? t("executionServerHint") : t("executionLocalHint"));
    } catch (error) {
      showExecutionMessage(executionErrorText(error), true);
    } finally {
      state.executionBusy = false;
      paintExecution();
    }
  }

  function money(n) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function reasonText(reason) {
    if (!reason) return "";
    if (String(reason).startsWith("budget_exceeded")) return t("reason_budget_exceeded");
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
      const n = Number(row.pnl);
      detail = `${row.side || ""} · ${Number.isFinite(n) ? `${n < 0 ? "\u2212" : "+"}$${Math.abs(n).toFixed(2)}` : ""}`.trim();
    } else if (type === "test_order") {
      title = row.dryRun ? t("logTestDry") : t("logTest");
      detail = `${row.side || ""} \u00b7 $${row.sizeUsd || ""} @ ${row.price || ""}`;
    } else if (type === "test_order_error") {
      title = t("logTestFail");
      detail = row.message || "";
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
    } else if (type === "auto_paused") {
      title = t("logPaused");
      detail = row.reason || "";
    } else if (type === "daily_limit") {
      title = t("dailyLimitHit");
      detail = `$${row.pnl} / $${row.limit}`;
    } else if (type === "venue_failure") {
      title = t("logVenueFailure");
      detail = `${row.count} \u00b7 ${row.reason || ""}`;
    } else if (type === "connect") {
      title = row.ready ? t("connectReady") : t("connectNotReady");
    } else if (type === "start_refused") {
      title = t("logStartRefused");
      detail = `${reasonText(row.reason)}${row.country ? ` (${row.country})` : ""}`;
    } else if (type === "dry_run") {
      title = row.on ? t("logDryOn") : t("logDryOff");
    } else if (type === "stake_capped") {
      title = t("logCapped");
      detail = `$${row.needed} \u2192 $${row.cap}`;
    }
    if (type === "order_sent" && row.dryRun) title = t("logDryOrder");
    const kind = type === "settled" ? (row.status === "win" ? "win" : "loss") : type;
    return { when, title, detail, kind };
  }

  function logNote(text) {
    const log = $("log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "log-row log-halt";
    div.textContent = text;
    log.prepend(div);
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
    const execution = snap.execution || state.execution;
    if (execution?.mode === "server" && !execution.connected && state.snapshot) {
      snap = { ...state.snapshot, execution, executionStale: true };
    } else if (execution) {
      snap = { ...snap, execution, executionStale: false };
    }
    state.snapshot = snap;
    if (execution) state.execution = execution;
    state.running = snap.running;
    state.mode = snap.mode;
    const lamp = $("statusLamp");
    if (lamp) {
      lamp.dataset.status = snap.status;
      lamp.dataset.on = snap.running ? "1" : "0";
      lamp.title = statusLabel(snap.status) + (snap.pauseReason ? ` \u2014 ${snap.pauseReason}` : "");
    }
    const badge = $("moneyBadge");
    if (badge) {
      const auto = snap.mode === "auto";
      badge.hidden = !auto;
      // only touch what changed, so the collapse animation is not restarted every tick
      const book = snap.book === "live" ? "live" : "dry";
      if (badge.dataset.book !== book) badge.dataset.book = book;
      const text = book === "live" ? t("badgeLive") : t("badgeDry");
      const label = badge.querySelector(".mb-text");
      if (label && label.textContent !== text) label.textContent = text;
      const hint = book === "live" ? t("badgeLiveHint") : t("badgeDryHint");
      if (badge.title !== hint) {
        badge.title = hint;
        badge.setAttribute("aria-label", `${text}. ${hint}`);
      }
    }
    paintChromePicks(snap);
    paintBalance(snap);
    $("series").textContent = `${snap.risk.step}/${snap.risk.maxSteps} · $${snap.risk.size}`;
    const pnl = Number(snap.todayPnl);
    $("pnl").textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    $("pnl").style.color = pnl > 0 ? "var(--pos)" : pnl < 0 ? "var(--neg)" : "var(--ink)";
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
    if ($("panelBody")?.querySelector("#planBox")) state.paintPlan?.(snap);
    updateSettingsLockUi(snap);
    paintExecution(execution);
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

  function themeKey(id) {
    return { "glass-dark": "glassDark", "glass-light": "glassLight", "glass-blue": "glassBlue" }[id] || "glassDark";
  }

  function closeMenus() {
    document.querySelectorAll(".v-menu.open").forEach((m) => m.classList.remove("open"));
    state.openMenu = null;
  }

  /** Coin / network mark: bundled SVG, or a letter badge when there is none. */
  function coinMark(icon, label) {
    if (icon) {
      const img = document.createElement("img");
      img.className = "coin";
      img.src = `assets/crypto/${icon}.svg`;
      img.alt = "";
      return img;
    }
    const span = document.createElement("span");
    span.className = "coin coin-letter";
    span.textContent = String(label || "?").charAt(0).toUpperCase();
    return span;
  }

  function fillOpt(node, opt) {
    node.textContent = "";
    if (opt.icon !== undefined) node.appendChild(coinMark(opt.icon, opt.label));
    const label = document.createElement("span");
    label.className = "v-opt-label";
    label.textContent = opt.label;
    node.appendChild(label);
    if (opt.note) {
      const note = document.createElement("span");
      note.className = "v-opt-note";
      note.textContent = opt.note;
      node.appendChild(note);
    }
  }

  function buildSelect(id, options, value, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "v-select";
    wrap.dataset.id = id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "v-select-btn";
    const current = options.find((o) => o.value === value) || options[0];
    const face = document.createElement("span");
    face.className = "v-face";
    if (current) fillOpt(face, current);
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▾";
    btn.append(face, chev);
    const menu = document.createElement("div");
    menu.className = "v-menu";
    options.forEach((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "v-opt";
      if (opt.icon !== undefined || opt.note) fillOpt(item, opt);
      else item.textContent = opt.label;
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
        fillOpt(face, opt);
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
    clearInterval(state.depositTimer);
    state.depositTimer = 0;
    clearInterval(state.telegramTimer);
    state.telegramTimer = 0;
    $("panel").hidden = true;
    $("backdrop").hidden = true;
    const foot = $("panelFoot");
    if (foot) {
      foot.hidden = true;
      foot.innerHTML = "";
    }
    closeMenus();
  }

  function saveSettingsSerial(patch) {
    const run = state.settingsSaveQueue.catch(() => {}).then(() => {
      if (executionUnavailable()) {
        const error = new Error(t("executionOfflineHint"));
        error.code = executionState()?.error || "remote_unavailable";
        throw error;
      }
      if (!window.vespera) return null;
      return window.vespera.saveSettings(patch).then(applySettingsReply);
    });
    state.settingsSaveQueue = run.catch(() => {});
    return run;
  }

  function settingError(message, field) {
    const box = $("settingsError");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
    if (field) {
      const input = $(({ baseUsd: "base", maxSteps: "steps", maxSeriesLossUsd: "maxSeriesLoss" })[field] || field);
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    }
  }

  function clearSettingError() {
    const box = $("settingsError");
    if (box) {
      box.textContent = "";
      box.hidden = true;
    }
    $("panelBody")?.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute("aria-invalid"));
  }

  function localizedSettingsError(err) {
    if (err && err.code === "settings_locked") return t("settingsLocked");
    if (err && err.code === "budget_exceeded") return t("reason_budget_exceeded");
    if (err && err.code === "invalid_settings") {
      const field = err.field || "";
      const key = `invalid_${field}`;
      return t(key) !== key ? t(key) : `${t("invalidSettings")}${field ? ` ${field}` : ""}`;
    }
    return `${t("settingsSaveFailed")}${err && err.message ? `: ${err.message}` : ""}`;
  }

  function applySettingsReply(reply) {
    if (reply && reply.ok === false) {
      if (reply.state && reply.state.settings) {
        state.snapshot = reply.state;
        renderSnap(reply.state);
      }
      const error = new Error(reply.message || reply.reason || "Settings save failed");
      error.code = reply.reason;
      error.field = reply.field;
      throw error;
    }
    return reply;
  }

  function canStartNewSeries(snap) {
    return Boolean(
      snap && !snap.running && Number(snap.risk?.consecutiveLosses) > 0 &&
      !snap.orderPending && !snap.testPositionActive && !snap.liveBet && !snap.paper?.openBet
    );
  }

  function updateSettingsLockUi(snap) {
    if (snap?.settings?.sizingMode === "fixed" && $("base")?.disabled && $("steps")?.disabled) {
      $("base").value = snap.settings.baseUsd;
      $("steps").value = snap.settings.maxSteps;
    }
    const notice = $("settingsLockNotice");
    if (notice) {
      notice.hidden = !snap?.settingsLocked;
      const reason = snap?.settingsLockReason;
      notice.textContent = reason
        ? (t(`settingsLock_${reason}`) !== `settingsLock_${reason}` ? t(`settingsLock_${reason}`) : String(reason))
        : t("settingsLocked");
    }
    const button = $("newSeries");
    if (button) button.hidden = !canStartNewSeries(snap) || $("panelBody")?.querySelector("[data-settings-tab].on")?.dataset.settingsTab !== "stakes";
    const blocked = executionUnavailable();
    if (typeof document !== "undefined") {
      document.querySelectorAll("#panelBody input, #panelBody textarea, #panelBody select, #panelBody button, #panelFoot button").forEach((el) => {
        if (el.closest("#executionSection") || el.matches("[data-settings-tab]")) return;
        if (blocked) {
          if (el.dataset.executionDisabled == null) el.dataset.executionDisabled = String(el.disabled);
          el.disabled = true;
        } else if (el.dataset.executionDisabled != null) {
          el.disabled = el.dataset.executionDisabled === "true";
          delete el.dataset.executionDisabled;
        }
      });
    }
  }

  function queueDebouncedSettings(patch, ms = 80) {
    state.queuedSettingsPatch = { ...state.queuedSettingsPatch, ...patch };
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      const queued = state.queuedSettingsPatch;
      state.queuedSettingsPatch = {};
      try {
        const current = state.snapshot?.settings || {};
        const normalized = window.VesperaSettings.normalizeSettings(queued, current, { strict: true });
        const snap = await saveSettingsSerial(normalized);
        if (!snap || !snap.settings) return;
        state.snapshot = snap;
        updateSettingsLockUi(snap);
        if (window.VesperaChart?.setRefreshMs) window.VesperaChart.setRefreshMs(snap.settings.refreshMs);
        if (queued.minCrossTicks != null || queued.minOpeningAtr != null || queued.confirmCount != null || queued.fullBodyOnS != null || queued.fastPeriod != null || queued.slowPeriod != null || queued.maType != null) {
          renderSnap(snap);
        }
        const panel = $("panelBody");
        if (panel && !$("panel").hidden) state.paintPlan?.(snap);
      } catch (err) {
        if (!$("panel").hidden) settingError(localizedSettingsError(err), err && err.field);
      }
    }, ms);
  }

  function debounceSave(patch, ms = 80) {
    queueDebouncedSettings(patch, ms);
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
      let next;
      try {
        next = await saveSettingsSerial(patch);
      } catch (err) {
        state.chromeKey = "";
        logNote(localizedSettingsError(err));
        if (state.snapshot) renderSnap(state.snapshot);
        return;
      }
      if (!next || !next.settings) return;
      const refused =
        (patch.symbol != null && next.settings.symbol !== patch.symbol) ||
        (patch.timeframe != null && next.settings.timeframe !== patch.timeframe);
      if (refused) {
        // the engine kept the old market: rebuild the pickers so they show it again
        state.chromeKey = "";
        const openBet = (next.paper && next.paper.openBet) || next.liveBet;
        logNote(t(openBet || next.mode !== "auto" ? "marketBlocked" : "marketAutoOnly"));
      }
      renderSnap(next);
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

  function captureSettingsDraft(body) {
    return {
      group: body.querySelector("[data-settings-tab].on")?.dataset.settingsTab || "interface",
      controls: [...body.querySelectorAll("input, textarea, select")].filter((el) => el.id).map((el) => ({
        id: el.id,
        value: el.value,
        checked: el.type === "checkbox" ? el.checked : undefined,
        invalid: el.getAttribute("aria-invalid"),
      })),
      buttons: [...body.querySelectorAll("#sizingSeg button, #maTypeSeg button, .settings-group [data-theme]")].map((el) => ({
        selector: el.matches("#sizingSeg button") ? "sizing" : el.matches("#maTypeSeg button") ? "ma" : "theme",
        value: el.dataset.sizing || el.dataset.ma || el.dataset.theme,
        on: el.classList.contains("on"),
      })),
      toggles: [...body.querySelectorAll(".settings-group .toggle")].map((el) => ({ id: el.id, on: el.classList.contains("on") })),
      pair: $("telegramPairCode")?.hidden ? null : {
        code: $("telegramPairCode")?.querySelector("code")?.textContent || "",
        expiresAt: $("telegramPairCode")?.lastElementChild?.dataset.expiresAt || "",
        expiry: $("telegramPairCode")?.lastElementChild?.textContent || "",
      },
      error: { text: $("settingsError")?.textContent || "", hidden: $("settingsError")?.hidden !== false },
    };
  }

  function restoreSettingsDraft(body, draft) {
    const activeTab = body.querySelector(`[data-settings-tab="${draft.group}"]`);
    if (activeTab) activeTab.click();
    draft.controls.forEach(({ id, value, checked, invalid }) => {
      const control = $(id);
      if (!control) return;
      control.value = value;
      if (checked !== undefined) control.checked = checked;
      if (invalid) control.setAttribute("aria-invalid", invalid);
      else control.removeAttribute("aria-invalid");
    });
    draft.buttons.forEach(({ selector, value, on }) => {
      const attribute = selector === "sizing" ? "sizing" : selector === "ma" ? "ma" : "theme";
      const container = selector === "sizing" ? $("sizingSeg") : selector === "ma" ? $("maTypeSeg") : $("settingsThemeSeg");
      container?.querySelectorAll(`button[data-${attribute}]`).forEach((el) => {
        if (el.dataset[attribute] === value) el.classList.toggle("on", on);
      });
    });
    draft.toggles.forEach(({ id, on }) => {
      const toggle = $(id);
      if (!toggle) return;
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-pressed", String(on));
    });
    const mode = $("sizingSeg")?.querySelector("button.on")?.dataset.sizing || "double";
    if ($("base")) $("base").disabled = mode === "fixed";
    if ($("steps")) $("steps").disabled = mode === "fixed";
    if ($("fixedStakes")) $("fixedStakes").disabled = mode !== "fixed";
    if ($("fixedModeHint")) $("fixedModeHint").hidden = mode !== "fixed";
    if ($("sizingWarning")) {
      $("sizingWarning").hidden = mode === "double";
      $("sizingWarning").textContent = mode === "fixed" ? t("fixedWarning") : mode === "recover" ? t("recoverWarning") : "";
    }
    if ($("maxEntryVal")) $("maxEntryVal").textContent = Number($("maxEntry")?.value) >= 100 ? t("off") : `\u2264 ${(Number($("maxEntry")?.value || 100) / 100).toFixed(2)}`;
    if ($("openingVal")) $("openingVal").textContent = `${(Number($("opening")?.value || 0) / 20).toFixed(2)} ATR`;
    if ($("confirmsVal")) $("confirmsVal").textContent = `${Number($("confirms")?.value || 0)} ${plural(Number($("confirms")?.value || 0), t("confirmCountUnit"))}`;
    if ($("fastPeriodVal")) $("fastPeriodVal").textContent = `${t("fastGeneric")} ${$("fastPeriod")?.value || "20"}`;
    if ($("slowPeriodVal")) $("slowPeriodVal").textContent = `${t("slowGeneric")} ${$("slowPeriod")?.value || "200"}`;
    if ($("refreshVal")) $("refreshVal").textContent = `${$("refresh")?.value || "100"} ${t("refreshUnit")}`;
    if ($("settingsError")) {
      $("settingsError").textContent = draft.error.text;
      $("settingsError").hidden = draft.error.hidden;
    }
    if (draft.pair?.code && $("telegramPairCode")) {
      const codeContainer = $("telegramPairCode");
      const label = document.createElement("span");
      label.className = "hint";
      label.textContent = t("telegramPairInstructions");
      const code = document.createElement("code");
      code.textContent = draft.pair.code;
      const expiry = document.createElement("span");
      expiry.className = "hint";
      expiry.dataset.expiresAt = draft.pair.expiresAt;
      const expiresAt = Number(draft.pair.expiresAt);
      expiry.textContent = Number.isFinite(expiresAt) && expiresAt > 0
        ? t("telegramPairExpires").replace("{time}", new Date(expiresAt).toLocaleTimeString(state.locale))
        : draft.pair.expiry;
      codeContainer.replaceChildren(label, code, expiry);
      codeContainer.hidden = false;
    }
    body.querySelectorAll("#settingsLangSeg button").forEach((button) => {
      button.classList.toggle("on", button.dataset.lang === state.locale);
    });
    state.paintSettingsSaveButton?.(draft.group);
    updateSettingsLockUi(state.snapshot);
  }

  function openPanel(kind) {
    const body = $("panelBody");
    const title = $("panelTitle");
    const foot = $("panelFoot");
    $("panel").hidden = false;
    $("backdrop").hidden = false;
    clearInterval(state.depositTimer);
    state.depositTimer = 0;
    clearInterval(state.telegramTimer);
    state.telegramTimer = 0;
    if (foot) {
      foot.hidden = true;
      foot.innerHTML = "";
    }
    closeMenus();

    if (kind === "api") {
      title.textContent = t("api");
      const sApi = state.snapshot?.settings || {};
      const storedHint = t("secretStored");
      body.innerHTML = `
        <p class="hint">${t("connectHint")}</p>
        <div class="field">
          <label>${t("walletAddress")}</label>
          <div class="api-row">
            <img class="api-mark" src="assets/polymarket.png" width="22" height="22" alt="Polymarket" />
            <input id="walletAddress" type="text" placeholder="${t("walletPlaceholder")}" autocomplete="off" spellcheck="false" />
          </div>
          <p class="hint">${t("walletWhere")}</p>
        </div>
        <div class="field">
          <label>${t("privateKey")}</label>
          <input id="privateKey" type="password" placeholder="${sApi.hasPrivKey ? storedHint : t("privateKeyPlaceholder")}" autocomplete="off" spellcheck="false" />
          <p class="hint">${t("privateKeyWhere")}</p>
        </div>
        <div class="field">
          <label>${t("walletType")}</label>
          <div id="walletTypeHost"></div>
          <p class="hint" id="walletTypeHint"></p>
        </div>
        <details class="adv" id="apiAdvanced">
          <summary>${t("advanced")}</summary>
          <div class="field" id="proxyField">
            <label>${t("proxyUrl")}</label>
            <input id="proxyUrl" type="text" placeholder="${t("proxyPlaceholder")}" autocomplete="off" spellcheck="false" />
          </div>
          <p class="hint" id="serverDirectHint" hidden>${t("executionLocalDirect")}</p>
          <p class="hint">${t("manualKeysHint")}</p>
          <div class="field">
            <label>${t("api")}</label>
            <input id="apiKey" type="password" placeholder="${sApi.hasApiKey ? storedHint : t("apiPlaceholder")}" autocomplete="off" />
          </div>
          <div class="field">
            <label>${t("apiSecret")}</label>
            <input id="apiSecret" type="password" placeholder="${sApi.hasApiSecret ? storedHint : t("apiSecretPlaceholder")}" autocomplete="off" />
          </div>
          <div class="field">
            <label>${t("apiPassphrase")}</label>
            <input id="apiPassphrase" type="password" placeholder="${sApi.hasApiPassphrase ? storedHint : t("apiPassphrasePlaceholder")}" autocomplete="off" />
          </div>
        </details>
        <button class="ok" id="btnConnect">${t("connect")}</button>
        <div class="checks" id="checks"></div>
        <section class="settings-info-card reconciliation-card">
          <div>
            <strong>${t("orderReconciliation")}</strong>
            <p class="hint">${t("orderReconciliationHint")}</p>
            <div class="settings-button-row"><button type="button" class="ghost" id="inspectPendingOrder">${t("inspectOrder")}</button><button type="button" class="ghost" id="restorePendingFill" hidden>${t("restoreFill")}</button></div>
            <p class="hint" id="orderEvidenceOutput" role="status" aria-live="polite"></p>
            <p class="hint">${t("finalSettlementHint")}</p>
            <button type="button" class="ghost" id="retryFinalSettlement">${t("retryFinalSettlement")}</button>
          </div>
        </section>
        <div class="test-bet">
          <div class="test-bet-row">
            <button type="button" class="ghost" id="btnTestUp">${t("testBetUp")}</button>
            <button type="button" class="ghost" id="btnTestDown">${t("testBetDown")}</button>
          </div>
          <p class="hint">${t("testBetHint")}</p>
          <p class="hint" id="testBetOut"></p>
        </div>
      `;
      let inspectedOrder = null;
      const reconciliationOutput = $("orderEvidenceOutput");
      const showReconciliation = (message) => { reconciliationOutput.textContent = message; };
      const reconciliationBusy = (busy) => {
        ["inspectPendingOrder", "restorePendingFill", "retryFinalSettlement"].forEach((id) => { $(id).disabled = busy || executionUnavailable(); });
      };
      $("inspectPendingOrder").onclick = async () => {
        reconciliationBusy(true);
        $("restorePendingFill").hidden = true;
        inspectedOrder = null;
        try {
          const result = await window.vespera.inspectPendingOrder();
          if (result.ok && result.kind === "filled") {
            inspectedOrder = result;
            showReconciliation(`${result.order.orderId} · ${result.order.side} · $${result.order.sizeUsd} · ${result.order.shares} shares @ ${Number(result.order.price).toFixed(5)} · fee $${result.order.feeUsd}`);
            $("restorePendingFill").hidden = false;
          } else showReconciliation(result.reason === "no_pending_order" ? t("reconciliationNone") : `${t("reconciliationBlocked")} ${result.reason || "unavailable"}`);
        } catch { showReconciliation(`${t("reconciliationBlocked")} unavailable`); }
        finally { reconciliationBusy(false); }
      };
      $("restorePendingFill").onclick = async () => {
        if (!inspectedOrder || !window.confirm(t("restoreFillConfirm"))) return;
        reconciliationBusy(true);
        try {
          const result = await window.vespera.resolvePendingOrder({ clientOrderId: inspectedOrder.clientOrderId, orderId: inspectedOrder.order.orderId, confirm: true });
          showReconciliation(result.ok ? t("reconciliationRestored") : `${t("reconciliationBlocked")} ${result.reason || "unavailable"}`);
          if (result.ok) { inspectedOrder = null; $("restorePendingFill").hidden = true; renderSnap(await window.vespera.snapshot()); }
        } catch { showReconciliation(`${t("reconciliationBlocked")} unavailable`); }
        finally { reconciliationBusy(false); }
      };
      $("retryFinalSettlement").onclick = async () => {
        reconciliationBusy(true);
        try {
          const result = await window.vespera.reconcileFinalSettlement();
          showReconciliation(result.ok ? t("finalSettlementReady") : result.reason === "no_final_settlement_pending" ? t("finalSettlementNone") : `${t("reconciliationBlocked")} ${result.reason || "pending"}`);
          renderSnap(await window.vespera.snapshot());
        } catch { showReconciliation(`${t("reconciliationBlocked")} unavailable`); }
        finally { reconciliationBusy(false); }
      };
      if (sApi.walletAddress) $("walletAddress").value = sApi.walletAddress;
      if (sApi.proxyUrl) {
        $("proxyUrl").value = sApi.proxyUrl;
        $("apiAdvanced").open = true;
      }
      if (executionState()?.mode === "server") {
        $("proxyField").hidden = true;
        $("serverDirectHint").hidden = false;
      }
      // Custom list: the native <select> popup ignores the dark theme on Windows.
      const walletTypeLabel = {
        AUTO: t("walletTypeAuto"),
        DEPOSIT_WALLET: t("walletTypeDeposit"),
        POLY_PROXY: t("walletTypeProxy"),
        POLY_GNOSIS_SAFE: t("walletTypeSafe"),
        EOA: t("walletTypeEoa"),
      };
      const typeName = (v) => walletTypeLabel[v] || v || "";
      let walletType = sApi.walletType || "AUTO";
      let detected = sApi.detectedWalletType || null;
      const paintWalletType = () => {
        const hint = $("walletTypeHint");
        if (!hint) return;
        hint.classList.remove("warn");
        if (!detected) {
          hint.textContent = walletType === "AUTO" ? t("walletTypeNeedKey") : "";
        } else if (walletType === "AUTO") {
          hint.textContent = `${t("walletTypeDetected")}: ${typeName(detected)}`;
        } else if (walletType !== detected) {
          hint.textContent = `${t("walletTypeMismatch")}: ${typeName(detected)}`;
          hint.classList.add("warn");
        } else {
          hint.textContent = "";
        }
      };
      const refreshDetected = async () => {
        const snap = await window.vespera.snapshot();
        if (!snap) return;
        state.snapshot = snap;
        detected = (snap.settings && snap.settings.detectedWalletType) || null;
        paintWalletType();
      };
      $("walletTypeHost").appendChild(
        buildSelect(
          "wallet-type",
          Object.keys(walletTypeLabel).map((value) => ({ value, label: walletTypeLabel[value] })),
          walletType,
          async (value) => {
            walletType = value;
            paintWalletType();
            await saveSettingsSerial({ walletType: value });
            await refreshDetected();
          }
        )
      );
      paintWalletType();
      $("walletAddress").onchange = async () => {
        await saveSettingsSerial({ walletAddress: $("walletAddress").value.trim() });
        await refreshDetected();
      };

      const short = (a) => (a ? `${String(a).slice(0, 6)}\u2026${String(a).slice(-4)}` : "");
      const usd = (n) => `$${Number(n).toFixed(2)}`;
      const reasonOf = (c) => esc(c.reason || "");
      // what Polymarket sees: country and IP, so a proxy that is not applied (or sits in a blocked country) is obvious
      const where = (c) =>
        [esc(c.country || ""), esc(c.ip || ""), c.proxied ? t("chkRegionViaProxy") : t("chkRegionDirect")].filter(Boolean).join(" \u00b7 ");
      const checkText = (c) => {
        const x = {
          network: {
            ok: () => [t("chkNetworkOk"), c.latencyMs ? `${c.latencyMs} ms` : ""],
            fail: () => [
              c.blocked ? t("chkNetworkBlocked") : t("chkNetworkFail"),
              c.blocked ? t("chkNetworkBlockedFix") : c.code && /^proxy_/.test(c.code) ? `${esc(reasonText(c.code))}<br>${reasonOf(c)}` : reasonOf(c),
            ],
          },
          region: {
            ok: () => [t("chkRegionOk"), where(c)],
            fail: () => [`${t("chkRegionBlocked")}${c.country ? ` (${esc(c.country)})` : ""}`, `${where(c)}. ${c.proxied ? t("chkRegionProxyBlocked") : t("chkRegionBlockedFix")}`],
            warn: () => [t("chkRegionUnknown"), reasonOf(c)],
          },
          key: {
            ok: () => [t("chkKeyOk"), esc(short(c.address))],
            fail: () => [c.reason === "missing" ? t("chkKeyMissing") : t("chkKeyInvalid"), ""],
          },
          wallet: {
            ok: () => [t("chkWalletOk"), esc(short(c.address))],
            fail: () => [c.reason === "missing" ? t("chkWalletMissing") : t("chkWalletInvalid"), ""],
          },
          walletType: {
            ok: () => [`${t("walletType")}: ${esc(typeName(c.used))}`, ""],
            warn: () => [`${t("walletType")}: ${esc(typeName(c.used))}`, `${t("walletTypeMismatch")}: ${esc(typeName(c.detected))}`],
          },
          clobKeys: {
            ok: () => [c.source === "manual" ? t("chkKeysManual") : t("chkKeysDerived"), ""],
            fail: () => [t("chkKeysFail"), `${reasonOf(c)}${c.httpStatus ? ` (${c.httpStatus})` : ""}`],
          },
          market: {
            ok: () => [t("chkMarketOk"), `${esc(c.slug)} \u00b7 UP ${Number(c.price).toFixed(3)} \u00b7 min ${c.minOrderSize}`],
            fail: () => [t("chkMarketFail"), reasonOf(c)],
          },
          balance: {
            ok: () => [`${t("chkBalance")}: ${usd(c.balance)}`, t("chkBalanceSeriesOk")],
            warn: () =>
              c.balance == null
                ? [t("chkBalance"), t("chkBalanceUnknown")]
                : [`${t("chkBalance")}: ${usd(c.balance)}`, `${t("chkBalanceSeriesShort")} ${usd(c.seriesNeed)}`],
            fail: () => [`${t("chkBalance")}: ${usd(c.balance)}`, `${t("chkBalanceFirstShort")} ${usd(c.firstNeed)}`],
          },
          allowance: {
            ok: () => [t("chkAllowanceOk"), ""],
            warn: () => [t("chkAllowanceUnknown"), ""],
            fail: () => [t("chkAllowanceFail"), t("chkAllowanceFix")],
          },
        }[c.id];
        const fn = x && x[c.status];
        return fn ? fn() : [t(`chk_${c.id}`), t("chkSkipped")];
      };
      const icon = { ok: "\u2713", warn: "!", fail: "\u2715", skip: "\u2013" };
      const paintChecks = (res) => {
        const host = $("checks");
        if (!host) return;
        if (!res) {
          host.innerHTML = "";
          return;
        }
        const rows = res.checks
          .map((c) => {
            const [head, detail] = checkText(c);
            return `<div class="chk chk-${c.status}"><span class="chk-ico">${icon[c.status] || ""}</span><div><div>${head}</div>${
              detail ? `<div class="hint">${detail}</div>` : ""
            }</div></div>`;
          })
          .join("");
        const extra = [];
        const bal = res.checks.find((c) => c.id === "balance");
        if (bal && bal.baseBelowMin) extra.push(`${t("chkBaseBelowMin")} ${usd(bal.minStake)}`);
        const when = res.at ? new Date(res.at).toLocaleTimeString() : "";
        const fund =
          bal && (bal.status === "fail" || bal.status === "warn")
            ? `<button type="button" class="ghost dep-fund" id="btnFund">${t("depFund")}</button>`
            : "";
        host.innerHTML = `
          <div class="chk-head" data-ready="${res.ready ? "1" : "0"}">${res.ready ? t("connectReady") : t("connectNotReady")}<span class="hint">${esc(when)}</span></div>
          ${rows}
          ${extra.map((e) => `<p class="hint warn">${e}</p>`).join("")}
          ${fund}`;
        if ($("btnFund")) $("btnFund").onclick = () => openPanel("deposit");
      };
      paintChecks(state.snapshot?.lastConnect);
      const testBet = async (side) => {
        const out = $("testBetOut");
        const btns = [$("btnTestUp"), $("btnTestDown")];
        btns.forEach((b) => (b.disabled = true));
        out.textContent = t("testBetWorking");
        try {
          let res = await window.vespera.testOrder({ side });
          if (res && res.reason === "test_confirm") {
            const ask = t(res.dryRun ? "testBetConfirmDry" : "testBetConfirm")
              .replace("{side}", res.side)
              .replace("{usd}", res.sizeUsd)
              .replace("{price}", Number(res.price).toFixed(2));
            if (!window.confirm(ask)) {
              out.textContent = "";
              return;
            }
            res = await window.vespera.testOrder({ side, confirm: true });
          }
          if (res && res.ok) {
            out.textContent = (res.dryRun ? t("testBetDry") : t("testBetOk"))
              .replace("{side}", res.side)
              .replace("{usd}", res.sizeUsd)
              .replace("{price}", res.price)
              .replace("{shares}", res.shares);
          } else {
            out.textContent = `${t("testBetFail")}: ${reasonText(res && res.reason)}${res && res.message ? ` \u00b7 ${res.message}` : ""}`;
          }
        } catch (err) {
          out.textContent = `${t("testBetFail")}: ${String((err && err.message) || err)}`;
        } finally {
          btns.forEach((b) => (b.disabled = false));
          renderSnap(await window.vespera.snapshot());
        }
      };
      $("btnTestUp").onclick = () => testBet("UP");
      $("btnTestDown").onclick = () => testBet("DOWN");
      $("btnConnect").onclick = async () => {
        const btn = $("btnConnect");
        btn.disabled = true;
        $("checks").innerHTML = `<p class="hint">${t("connectWorking")}</p>`;
        let res;
        try {
          res = await window.vespera.connect({
            walletAddress: $("walletAddress").value.trim(),
            privateKey: $("privateKey").value.trim(),
            walletType,
            proxyUrl: $("proxyUrl").value.trim(),
            apiKey: $("apiKey").value.trim(),
            apiSecret: $("apiSecret").value.trim(),
            apiPassphrase: $("apiPassphrase").value.trim(),
          });
        } catch (err) {
          res = { ready: false, checks: [{ id: "network", status: "fail", reason: String((err && err.message) || err) }] };
        }
        btn.disabled = false;
        // entered secrets are stored encrypted; never keep them in the DOM
        for (const id of ["privateKey", "apiKey", "apiSecret", "apiPassphrase"]) {
          if ($(id).value) {
            $(id).value = "";
            $(id).placeholder = storedHint;
          }
        }
        paintChecks(res);
        await refreshDetected();
        renderSnap(state.snapshot);
      };
    }

    if (kind === "deposit") {
      title.textContent = t("deposit");
      body.innerHTML = `
        <p class="hint">${t("depHint")}</p>
        <div class="dep-picks">
          <div class="field"><label>${t("depToken")}</label><div id="depTokenHost"></div></div>
          <div class="field"><label>${t("depNetwork")}</label><div id="depChainHost"></div></div>
        </div>
        <div id="depBody"><p class="hint">${t("depLoading")}</p></div>
        <div class="dep-history" id="depHistory" hidden>
          <div class="dep-history-h"><span>${t("depHistory")}</span><button type="button" class="dep-link" id="depRefresh">${t("depRefresh")}</button></div>
          <div id="depTx"></div>
        </div>
      `;
      const short = (a) => (a ? `${String(a).slice(0, 6)}\u2026${String(a).slice(-4)}` : "");
      const STABLES = ["USDT", "USDC", "DAI", "USDe", "USDT0", "USDC.e"];
      // Native coins come with placeholder contracts (0xEeee…); only show a real token contract.
      const showContract = (sym, net) =>
        STABLES.includes(sym) &&
        !/^0xe{40}$/i.test(net.tokenAddress) &&
        (/^0x[0-9a-f]{40}$/i.test(net.tokenAddress) || /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(net.tokenAddress) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(net.tokenAddress));
      const stateLabel = { done: t("depDone"), pending: t("depPending"), failed: t("depFailed") };
      let tokens = [];
      let symbol = "USDT";
      let chainId = "";
      let address = "";
      let seq = 0;
      const alive = () => !$("panel").hidden && $("depBody");

      const paintTx = async () => {
        if (!address || !alive()) return;
        const mine = address;
        const res = await window.vespera.depositStatus(mine);
        if (!alive() || mine !== address) return;
        $("depHistory").hidden = false;
        const host = $("depTx");
        if (!res || !res.ok) {
          host.innerHTML = `<p class="hint warn">${esc((res && res.reason) || "")}</p>`;
          return;
        }
        if (!res.transactions.length) {
          host.innerHTML = `<p class="hint">${t("depNone")}</p>`;
          return;
        }
        host.innerHTML = res.transactions
          .map((tx) => {
            const when = tx.createdTimeMs ? new Date(tx.createdTimeMs).toLocaleString() : "";
            const amount = tx.amount != null ? `${esc(tx.amount)} ${esc(tx.symbol)}` : esc(tx.symbol || "");
            return `<div class="dep-tx" data-state="${esc(tx.state)}">
              <div><div>${amount} <span class="hint">· ${esc(tx.chainName)}</span></div><div class="hint">${esc(when)}</div></div>
              <span class="dep-pill" title="${esc(tx.status)}">${esc(stateLabel[tx.state] || tx.status)}</span>
            </div>`;
          })
          .join("");
      };

      const paintAddress = async () => {
        const tok = tokens.find((x) => x.symbol === symbol);
        const net = tok && tok.networks.find((n) => n.chainId === chainId);
        const host = $("depBody");
        if (!tok || !net || !host) return;
        const mySeq = ++seq;
        address = "";
        $("depHistory").hidden = true;
        host.innerHTML = `<p class="hint">${t("depLoading")}</p>`;
        const res = await window.vespera.depositAddress(net.addressType);
        if (mySeq !== seq || !alive()) return;
        if (!res || !res.ok) {
          if (res && (res.reason === "wallet_missing" || res.reason === "wallet_invalid")) {
            host.innerHTML = `<p class="hint warn">${t("depWalletMissing")}</p>
              <button type="button" class="ghost" id="depOpenApi">${t("depOpenApi")}</button>`;
            $("depOpenApi").onclick = () => openPanel("api");
          } else {
            host.innerHTML = `<p class="hint warn">${t("depFail")}: ${esc((res && res.reason) || "")}</p><p class="hint">${t("depProxyHint")}</p>`;
          }
          return;
        }
        address = res.address;
        const only = t("depOnly").replace("{token}", tok.symbol).replace("{network}", net.chainName);
        const contract = showContract(tok.symbol, net)
          ? `<div class="dep-kv"><span>${t("depContract")}</span><span class="mono" title="${esc(net.tokenAddress)}">${esc(short(net.tokenAddress))}</span></div>`
          : "";
        host.innerHTML = `
          <div class="dep-card">
            <img class="dep-qr" src="${esc(res.qr)}" alt="QR" width="132" height="132" />
            <div class="dep-info">
              <label>${t("depAddress")} · ${esc(tok.symbol)} (${esc(net.chainName)})</label>
              <div class="dep-addr mono" id="depAddr">${esc(res.address)}</div>
              <button type="button" class="ghost dep-copy" id="depCopy">${t("depCopy")}</button>
            </div>
          </div>
          <div class="dep-kvs">
            <div class="dep-kv"><span>${t("depMinDeposit")}</span><span>$${esc(net.minUsd)}</span></div>
            ${contract}
            <div class="dep-kv"><span>${t("depArrives")}</span><span class="mono" title="${esc(res.wallet)}">pUSD · ${esc(short(res.wallet))}</span></div>
          </div>
          <p class="hint warn">${esc(only)}</p>`;
        $("depCopy").onclick = async () => {
          await window.vespera.copyText(res.address);
          const b = $("depCopy");
          if (!b) return;
          b.textContent = t("depCopied");
          setTimeout(() => {
            if ($("depCopy")) $("depCopy").textContent = t("depCopy");
          }, 1400);
        };
        paintTx();
      };

      const paintChains = () => {
        const tok = tokens.find((x) => x.symbol === symbol) || tokens[0];
        if (!tok) return;
        symbol = tok.symbol;
        if (!tok.networks.some((n) => n.chainId === chainId)) chainId = tok.networks[0].chainId;
        const host = $("depChainHost");
        host.innerHTML = "";
        host.appendChild(
          buildSelect(
            "dep-chain",
            tok.networks.map((n) => ({ value: n.chainId, label: n.chainName, icon: n.icon, note: `${t("depMin")} $${n.minUsd}` })),
            chainId,
            (v) => {
              chainId = v;
              saveSettingsSerial({ depositChain: v }).catch((err) => logNote(localizedSettingsError(err)));
              paintAddress();
            }
          )
        );
        paintAddress();
      };

      (async () => {
        const [saved, res] = await Promise.all([window.vespera.getSettings(), window.vespera.depositAssets()]);
        if (!alive()) return;
        if (saved && saved.depositToken) symbol = saved.depositToken;
        if (saved && saved.depositChain) chainId = saved.depositChain;
        if (!res || !res.ok || !res.tokens.length) {
          $("depBody").innerHTML = `<p class="hint warn">${t("depFail")}: ${esc((res && res.reason) || "")}</p><p class="hint">${t("depProxyHint")}</p>`;
          return;
        }
        tokens = res.tokens;
        if (!tokens.some((x) => x.symbol === symbol)) symbol = tokens[0].symbol;
        $("depTokenHost").appendChild(
          buildSelect(
            "dep-token",
            tokens.map((x) => ({ value: x.symbol, label: x.symbol, icon: x.icon })),
            symbol,
            (v) => {
              symbol = v;
              saveSettingsSerial({ depositToken: v }).catch((err) => logNote(localizedSettingsError(err)));
              paintChains();
            }
          )
        );
        paintChains();
      })();
      $("depRefresh").onclick = () => paintTx();
      // deposits take minutes; poll while the panel stays open
      state.depositTimer = setInterval(paintTx, 15000);
    }

    if (kind === "theme") {
      title.textContent = t("theme");
      body.innerHTML = `<div class="theme-grid" id="themeSeg">${THEMES.map(
        (id) => `<button type="button" class="theme-card" data-theme="${id}" aria-label="${t(themeKey(id))}">
          <span class="theme-swatch" data-swatch="${id}"><i></i><i></i><i></i></span>
          <span class="theme-name">${t(themeKey(id))}</span>
        </button>`
      ).join("")}</div>`;
      document.querySelectorAll("#themeSeg button").forEach((b) => {
        b.classList.toggle("on", b.dataset.theme === state.theme);
        b.onclick = async () => {
          state.theme = b.dataset.theme;
          applyTheme();
          document.querySelectorAll("#themeSeg button").forEach((x) =>
            x.classList.toggle("on", x.dataset.theme === state.theme)
          );
          if (window.vespera) await saveSettingsSerial({ theme: state.theme });
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
          const draft = captureSettingsDraft(body);
          state.locale = b.dataset.lang;
          applyI18n();
          document.querySelectorAll("#settingsLangSeg button, #langSeg button").forEach((x) =>
            x.classList.toggle("on", x.dataset.lang === state.locale)
          );
          try {
            if (window.vespera) await saveSettingsSerial({ locale: state.locale });
            openPanel("settings");
            restoreSettingsDraft(body, draft);
          } catch (error) {
            settingError(localizedSettingsError(error));
          }
        };
      });
    }

    if (kind === "settings") {
      title.textContent = t("settings");
      const s = state.snapshot?.settings || {};
      const execution = executionState() || { mode: "local", connected: true, configured: false };
      const executionLocked = execution.mode === "server" || Boolean(execution.switching);
      const limits = window.VesperaSettings.LIMITS;
      body.innerHTML = `
        <nav class="settings-tabs" role="tablist" aria-label="${t("settingsGroups")}">
          ${[["strategy", "settingsStrategy"], ["stakes", "settingsStakes"], ["execution", "execution"], ["polymarket", "polymarket"], ["telegram", "telegram"], ["interface", "interface"]].map(([group, key], index) => `<button type="button" role="tab" id="settingsTab-${group}" aria-controls="settingsGroup-${group}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-settings-tab="${group}" class="${index === 0 ? "on" : ""}">${t(key)}</button>`).join("")}
        </nav>
        <div id="settingsError" class="hint warn settings-error" role="alert" hidden></div>
        <p class="hint warn settings-error" id="settingsLockNotice" role="status" hidden></p>
        <p class="hint settings-save-hint">${t("settingsSaveHint")}</p>
        <div class="settings-sections">
        <section class="settings-group" id="settingsGroup-execution" data-settings-group="execution" role="tabpanel" aria-labelledby="settingsTab-execution" hidden>
          <section class="execution-section" id="executionSection">
            <div class="execution-section-heading">${t("execution")}</div>
          <div class="field">
            <label for="executionUrl">${t("serverUrl")}</label>
            <input id="executionUrl" type="url" value="${esc(execution.url || "")}" placeholder="https://server.example" autocomplete="url" spellcheck="false" ${executionLocked ? "disabled" : ""} />
          </div>
          <div class="field">
            <label for="executionToken">${t("serverToken")}</label>
            <input id="executionToken" type="password" placeholder="${execution.hasToken ? t("serverTokenSaved") : ""}" autocomplete="new-password" ${execution.switching || execution.pendingTarget ? "disabled" : ""} />
          </div>
          <div class="execution-actions">
            <button type="button" class="ghost" id="executionConnect" ${execution.switching ? "disabled" : ""}>${t("serverConnectSave")}</button>
            <div class="execution-mode-control"><span>${t("zeroMode")}</span><button type="button" class="toggle ${execution.mode === "server" ? "on" : ""}" id="zeroModeToggle" aria-pressed="${execution.mode === "server"}" ${execution.switching || (execution.mode === "server" && !execution.connected) ? "disabled" : ""}><span class="knob"></span></button></div>
          </div>
          <button type="button" class="ghost execution-retry" id="executionRetry" ${execution.pendingTarget ? "" : "hidden"} ${execution.switching ? "disabled" : ""}>${t("executionRetry")}</button>
          <p class="hint" id="executionStatusHint">${execution.error ? esc(executionErrorText(execution.error, "")) : execution.mode === "server" ? (execution.connected ? t("executionServerHint") : t("executionOfflineHint")) : t("executionLocalHint")}</p>
          <p class="hint" id="executionRouteHint" ${execution.mode === "server" ? "" : "hidden"}>${t("executionRouteHint")}</p>
          <p class="hint warn execution-message" id="executionMessage" role="status" hidden></p>
          </section>
        </section>
        <section class="settings-group" id="settingsGroup-stakes" data-settings-group="stakes" role="tabpanel" aria-labelledby="settingsTab-stakes" hidden>
        <div class="field toggle-row">
          <span class="field-label">${t("sizing")}${helpBtn("sizingHint")}</span>
          <div class="seg seg-sm" id="sizingSeg">
            <button type="button" data-sizing="double" class="${(s.sizingMode || "double") === "double" ? "on" : ""}">${t("sizingDouble")}</button>
            <button type="button" data-sizing="fixed" class="${s.sizingMode === "fixed" ? "on" : ""}">${t("sizingFixed")}</button>
            <button type="button" data-sizing="recover" class="${s.sizingMode === "recover" ? "on" : ""}">${t("sizingRecover")}</button>
          </div>
        </div>
        <div class="field"><span class="field-label">${t("fixedStakes")}</span><textarea id="fixedStakes" rows="2">${esc(Array.isArray(s.fixedStakes) ? s.fixedStakes.join(", ") : "1, 2, 4, 8, 16, 32")}</textarea><p class="hint">${t("fixedStakesHint")}</p></div>
        <p class="hint" id="fixedModeHint" hidden>${t("fixedModeHint")}</p>
        <p class="hint warn" id="sizingWarning" hidden></p>
        <div class="field"><span class="field-label">${t("base")}</span><input id="base" type="number" min="${limits.baseUsd.min}" max="${limits.baseUsd.max}" step="${limits.baseUsd.step}" value="${esc(s.baseUsd || "1.00")}" /></div>
        <div class="field"><span class="field-label">${t("maxSteps")}</span><input id="steps" type="number" min="${limits.maxSteps.min}" max="${limits.maxSteps.max}" step="${limits.maxSteps.step}" value="${esc(s.maxSteps || 6)}" /></div>
        <div class="field"><span class="field-label">${t("maxStake")}${helpBtn("maxStakeHint")}</span><input id="maxStake" type="number" min="${limits.maxStakeUsd.min}" max="${limits.maxStakeUsd.max}" step="${limits.maxStakeUsd.step}" inputmode="decimal" value="${Number(s.maxStakeUsd) > 0 ? s.maxStakeUsd : ""}" placeholder="${t("maxStakeOff")}" /></div>
        <div class="field">
          <span class="field-label">${t("maxEntryPrice")}${helpBtn("maxEntryPriceHint")}</span>
          <div class="range-row">
            <input id="maxEntry" type="range" min="${limits.maxEntryPrice.min * 100}" max="${limits.maxEntryPrice.max * 100}" step="${limits.maxEntryPrice.step * 100}" />
            <span class="range-val" id="maxEntryVal"></span>
          </div>
        </div>
        <div class="plan-box" id="planBox"></div>
        <div class="field"><span class="field-label">${t("dailyLimit")}${helpBtn("dailyLimitHint")}</span><input id="dailyLimit" type="number" min="${limits.dailyLossLimitUsd.min}" max="${limits.dailyLossLimitUsd.max}" step="${limits.dailyLossLimitUsd.step}" inputmode="decimal" value="${Number(s.dailyLossLimitUsd) > 0 ? s.dailyLossLimitUsd : ""}" placeholder="${t("maxStakeOff")}" /></div>
        <div class="field"><span class="field-label">${t("maxSeriesLoss")}${helpBtn("maxSeriesLossHint")}</span><input id="maxSeriesLoss" type="number" min="${limits.maxSeriesLossUsd.min}" max="${limits.maxSeriesLossUsd.max}" step="${limits.maxSeriesLossUsd.step}" inputmode="decimal" value="${Number(s.maxSeriesLossUsd) > 0 ? s.maxSeriesLossUsd : ""}" placeholder="${t("maxStakeOff")}" /></div>
        </section>
        <section class="settings-group" id="settingsGroup-execution-dryrun" data-settings-group="execution" role="tabpanel" aria-labelledby="settingsTab-execution" hidden>
        <div class="field toggle-row">
          <span class="field-label">${t("dryRun")}${helpBtn("dryRunHint")}</span>
          <button type="button" class="toggle ${s.dryRun !== false ? "on" : ""}" id="dryRunToggle" aria-pressed="${s.dryRun !== false}">
            <span class="knob"></span>
          </button>
        </div>
        </section>
        <section class="settings-group" id="settingsGroup-strategy" data-settings-group="strategy" role="tabpanel" aria-labelledby="settingsTab-strategy">
        <div class="field">
          <span class="field-label">${t("minOpening")}${helpBtn("minOpeningHint")}</span>
          <div class="range-row">
            <input id="opening" type="range" min="${limits.minOpeningAtr.min * 20}" max="${limits.minOpeningAtr.max * 20}" step="${limits.minOpeningAtr.step * 20}" />
            <span class="range-val" id="openingVal">0.00 ATR</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("minCross")}${helpBtn("minCrossHint")}</span>
          <div class="range-row">
            <input id="crossTicks" type="range" min="${limits.minCrossTicks.min}" max="${limits.minCrossTicks.max}" step="${limits.minCrossTicks.step}" />
            <span class="range-val" id="crossVal">0 ${plural(0, t("minCrossUnit"))}</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("confirmCount")}${helpBtn("confirmCountHint")}</span>
          <div class="range-row">
            <input id="confirms" type="range" min="${limits.confirmCount.min}" max="${limits.confirmCount.max}" step="${limits.confirmCount.step}" />
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
            <input id="fastPeriod" type="range" min="${limits.fastPeriod.min}" max="${limits.fastPeriod.max}" step="${limits.fastPeriod.step}" />
            <span class="range-val" id="fastPeriodVal">SMA20</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">${t("slowPeriod")}${helpBtn("slowPeriodHint")}</span>
          <div class="range-row">
            <input id="slowPeriod" type="range" min="${limits.slowPeriod.min}" max="${limits.slowPeriod.max}" step="${limits.slowPeriod.step}" />
            <span class="range-val" id="slowPeriodVal">SMA200</span>
          </div>
        </div>
        <div class="field toggle-row">
          <span class="field-label">${t("fullBodyOnS")}${helpBtn("fullBodyOnSHint")}</span>
          <button type="button" class="toggle ${s.fullBodyOnS ? "on" : ""}" id="fullBodyToggle" aria-pressed="${Boolean(s.fullBodyOnS)}">
            <span class="knob"></span>
          </button>
        </div>
        </section>
        <section class="settings-group" id="settingsGroup-interface" data-settings-group="interface" role="tabpanel" aria-labelledby="settingsTab-interface" hidden>
          <div class="field">
            <span class="field-label">${t("refresh")}${helpBtn("refreshHint")}</span>
            <div class="range-row">
              <input id="refresh" type="range" min="${limits.refreshMs.min}" max="${limits.refreshMs.max}" step="${limits.refreshMs.step}" />
              <span class="range-val" id="refreshVal">100 ${t("refreshUnit")}</span>
            </div>
          </div>
          <div class="settings-interface-row">
            <span class="field-label">${t("theme")}</span>
            <div class="theme-grid" id="settingsThemeSeg">${THEMES.map((id) => `<button type="button" class="theme-card" data-theme="${id}" aria-label="${t(themeKey(id))}"><span class="theme-swatch" data-swatch="${id}"><i></i><i></i><i></i></span><span class="theme-name">${t(themeKey(id))}</span></button>`).join("")}</div>
          </div>
          <div class="field">
            <span class="field-label">${t("language")}</span>
            <div class="seg" id="settingsLangSeg"><button type="button" data-lang="en" class="${state.locale === "en" ? "on" : ""}">English</button><button type="button" data-lang="ru" class="${state.locale === "ru" ? "on" : ""}">Русский</button></div>
          </div>
        </section>
        <section class="settings-group" id="settingsGroup-polymarket" data-settings-group="polymarket" role="tabpanel" aria-labelledby="settingsTab-polymarket" hidden>
          <div class="settings-info-card"><img class="api-mark" src="assets/polymarket.png" width="22" height="22" alt="Polymarket" /><div><strong>Polymarket</strong><p class="hint">${t("settingsPolymarketHint")}</p></div></div>
          <button type="button" class="ghost settings-open-panel" id="settingsOpenPolymarket">${t("settingsPolymarketOpen")}</button>
        </section>
        <section class="settings-group" id="settingsGroup-telegram" data-settings-group="telegram" role="tabpanel" aria-labelledby="settingsTab-telegram" hidden>
          <div class="settings-info-card"><span class="settings-service-icon" aria-hidden="true">✈</span><div><strong>${t("telegram")}</strong><p class="hint" id="telegramRuntimeHint"></p></div></div>
          <p class="hint" id="telegramStatus" role="status" aria-live="polite">${t("telegramChecking")}</p>
          <p class="hint" id="telegramConnection"></p>
          <div class="field toggle-row"><label class="field-label" for="telegramEnabled">${t("telegramEnabled")}</label><input type="checkbox" class="settings-checkbox" id="telegramEnabled" disabled /></div>
          <div class="field"><label for="telegramToken">${t("telegramToken")}</label><input id="telegramToken" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t("telegramTokenPlaceholder")}" /><p class="hint">${t("telegramTokenHint")}</p></div>
          <div class="settings-button-row"><button type="button" class="ghost" id="telegramSave" disabled>${t("telegramSave")}</button><button type="button" class="ghost" id="telegramPair" disabled>${t("telegramPair")}</button></div>
          <div class="settings-pair-code" id="telegramPairCode" hidden></div>
          <div class="settings-button-row"><button type="button" class="ghost" id="telegramTest" disabled>${t("telegramTest")}</button><button type="button" class="ghost" id="telegramDisconnect" disabled>${t("telegramDisconnect")}</button></div>
          <p class="hint" id="telegramActionStatus" role="status" aria-live="polite" hidden></p>
          <p class="hint" id="telegramMembers"></p>
        </section>
        <section class="settings-group" id="settingsGroup-interface-notifications" data-settings-group="interface" role="tabpanel" aria-labelledby="settingsTab-interface" hidden>
        <div class="field toggle-row">
          <span class="field-label">${t("notify")}${helpBtn("notifyHint")}</span>
          <button type="button" class="toggle ${s.notificationsEnabled !== false ? "on" : ""}" id="notifyToggle" aria-pressed="${s.notificationsEnabled !== false}">
            <span class="knob"></span>
          </button>
        </div>
        </section>
        </div>
      `;
      const selectSettingsGroup = (group) => {
        body.querySelectorAll("[data-settings-tab]").forEach((tab) => {
          const selected = tab.dataset.settingsTab === group;
          tab.classList.toggle("on", selected);
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
        });
        body.querySelectorAll("[data-settings-group]").forEach((section) => {
          section.hidden = section.dataset.settingsGroup !== group;
        });
        state.paintSettingsSaveButton?.(group);
      };
      body.querySelectorAll("[data-settings-tab]").forEach((tab) => {
        tab.onclick = () => selectSettingsGroup(tab.dataset.settingsTab);
        tab.onkeydown = (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const tabs = [...body.querySelectorAll("[data-settings-tab]")];
          const index = tabs.indexOf(tab);
          const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          next.focus();
          selectSettingsGroup(next.dataset.settingsTab);
        };
      });
      $("settingsOpenPolymarket").onclick = () => openPanel("api");
      const updateSettingsThemes = () => {
        document.querySelectorAll(".settings-group [data-theme]").forEach((button) => {
          button.classList.toggle("on", button.dataset.theme === state.theme);
        });
      };
      updateSettingsThemes();
      body.querySelectorAll(".settings-group [data-theme]").forEach((button) => {
        button.onclick = async () => {
          const previous = state.theme;
          state.theme = button.dataset.theme;
          applyTheme();
          updateSettingsThemes();
          try {
            await saveSettingsSerial({ theme: state.theme });
          } catch (error) {
            state.theme = previous;
            applyTheme();
            updateSettingsThemes();
            settingError(localizedSettingsError(error));
          }
        };
      });
      body.querySelectorAll("#settingsLangSeg [data-lang]").forEach((button) => {
        button.onclick = async () => {
          if (button.dataset.lang === state.locale) return;
          const previous = state.locale;
          const draft = captureSettingsDraft(body);
          state.locale = button.dataset.lang;
          applyI18n();
          body.querySelectorAll("#settingsLangSeg [data-lang]").forEach((item) => {
            item.classList.toggle("on", item.dataset.lang === state.locale);
          });
          try {
            await saveSettingsSerial({ locale: state.locale });
            openPanel("settings");
            restoreSettingsDraft(body, draft);
          } catch (error) {
            state.locale = previous;
            applyI18n();
            body.querySelectorAll("#settingsLangSeg button").forEach((item) => {
              item.classList.toggle("on", item.dataset.lang === state.locale);
            });
            restoreSettingsDraft(body, draft);
            settingError(localizedSettingsError(error));
          }
        };
      });
      const telegram = window.vespera;
      const telegramControlIds = ["telegramEnabled", "telegramToken", "telegramSave", "telegramPair", "telegramTest", "telegramDisconnect"];
      let telegramSnapshot = null;
      let telegramBusy = false;
      let telegramStatusPending = false;
      const hasTelegramApi = ["telegramStatus", "telegramConfigure", "telegramPair", "telegramTest", "telegramDisconnect"].every((method) => typeof telegram?.[method] === "function");
      const telegramConfigured = () => Boolean(telegramSnapshot?.hasToken ?? telegramSnapshot?.enabled);
      const setTelegramBusy = (busy) => {
        telegramBusy = busy;
        const status = $("telegramStatus");
        telegramControlIds.forEach((id) => {
          const control = $(id);
          if (!control) return;
          control.disabled = !hasTelegramApi || busy || executionUnavailable() || (id === "telegramPair" || id === "telegramTest") && !(telegramSnapshot?.enabled && telegramConfigured()) || id === "telegramDisconnect" && !(telegramSnapshot?.hasToken || telegramSnapshot?.hasToken == null && telegramSnapshot?.enabled);
        });
        if (status && !hasTelegramApi) status.textContent = t("telegramUnavailable");
      };
      const refreshTelegram = async (keepBusy = false, quiet = false) => {
        if (!$("telegramStatus")) return;
        if (telegramBusy && !keepBusy || telegramStatusPending) return;
        if (!hasTelegramApi) {
          $("telegramStatus").textContent = t("telegramUnavailable");
          setTelegramBusy(false);
          return;
        }
        telegramStatusPending = true;
        if (!quiet) $("telegramStatus").textContent = t("telegramChecking");
        try {
          const status = await telegram.telegramStatus();
          const statusEl = $("telegramStatus");
          if (!statusEl || $("panel").hidden || !$("telegramStatus")) return;
          if (!status || typeof status !== "object") throw new Error("status");
          telegramSnapshot = status;
          const botName = typeof (status.botName || status.botUsername) === "string" ? (status.botName || status.botUsername) : "";
          const connected = status.connected === true || status.connected == null && Boolean(status.enabled && botName);
          statusEl.textContent = connected
            ? t("telegramStatusConnected").replace("{name}", botName ? `@${botName.replace(/^@/, "")}` : t("telegramBot"))
            : t(status.enabled ? "telegramStatusOffline" : "telegramStatusDisabled");
          const connection = $("telegramConnection");
          if (connection) connection.textContent = status.hasToken || status.hasToken == null && status.enabled ? t("telegramTokenSaved") : t("telegramTokenNotSaved");
          const enabled = $("telegramEnabled");
          if (enabled && !state.telegramDraftDirty) enabled.checked = Boolean(status.enabled);
          const count = (value) => Array.isArray(value) ? value.length : Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
          const members = $("telegramMembers");
          const users = status.users ?? status.approvedUsers;
          const pending = status.pendingRequests ?? status.requests;
          const hasAdmin = status.adminId != null || Number(status.rootAdminCount) > 0;
          if (members) members.textContent = `${t("telegramUsers").replace("{count}", String(count(users)))} · ${t("telegramPending").replace("{count}", String(count(pending)))} · ${t(hasAdmin ? "telegramAdminLinked" : "telegramAdminMissing")}`;
          setTelegramBusy(keepBusy);
        } catch {
          const statusEl = $("telegramStatus");
          if (!statusEl || $("panel").hidden || !$("telegramStatus")) return;
          telegramSnapshot = null;
          statusEl.textContent = t("telegramStatusError");
          setTelegramBusy(keepBusy);
        } finally {
          telegramStatusPending = false;
        }
      };
      const showTelegramAction = (key, error = false) => {
        const message = $("telegramActionStatus");
        if (!message) return;
        message.textContent = t(key);
        message.classList.toggle("warn", error);
        message.hidden = false;
      };
      const runTelegramAction = async (action, successKey) => {
        if (!hasTelegramApi || telegramBusy) return;
        setTelegramBusy(true);
        const message = $("telegramActionStatus");
        if (message) message.hidden = true;
        try {
          const result = await action();
          if (result?.ok === false) throw new Error("action");
          await refreshTelegram(true);
          showTelegramAction(successKey);
          return result;
        } catch {
          showTelegramAction("telegramActionError", true);
          await refreshTelegram(true);
          return null;
        } finally {
          setTelegramBusy(false);
        }
      };
      $("telegramSave").onclick = async () => {
        const token = $("telegramToken");
        const enabled = $("telegramEnabled");
        const result = await runTelegramAction(() => telegram.telegramConfigure({ ...(token.value ? { token: token.value } : {}), enabled: enabled.checked }), "telegramSaved");
        if (result) {
          token.value = "";
          state.telegramDraftDirty = false;
        }
      };
      $("telegramToken").oninput = () => { state.telegramDraftDirty = true; };
      $("telegramEnabled").onchange = () => { state.telegramDraftDirty = true; };
      $("telegramPair").onclick = async () => {
        const pairButton = $("telegramPair");
        const codeContainer = $("telegramPairCode");
        if (codeContainer) {
          codeContainer.replaceChildren();
          codeContainer.hidden = true;
        }
        const result = await runTelegramAction(async () => {
          const reply = await telegram.telegramPair();
          if (!reply || reply.ok === false || typeof reply.code !== "string" || !reply.code) throw new Error("pair");
          return reply;
        }, "telegramPairCreated");
        const currentCodeContainer = $("telegramPairCode");
        if (!result || !currentCodeContainer) return;
        const label = document.createElement("span");
        label.className = "hint";
        label.textContent = t("telegramPairInstructions");
        const code = document.createElement("code");
        code.textContent = result.code;
        const expiry = document.createElement("span");
        expiry.className = "hint";
        const expiresAt = typeof result.expiresAt === "number"
          ? (result.expiresAt < 1e12 ? result.expiresAt * 1000 : result.expiresAt)
          : Date.parse(result.expiresAt);
        expiry.dataset.expiresAt = Number.isFinite(expiresAt) ? String(expiresAt) : "";
        expiry.textContent = Number.isFinite(expiresAt)
          ? t("telegramPairExpires").replace("{time}", new Date(expiresAt).toLocaleTimeString(state.locale))
          : t("telegramPairCreated");
        currentCodeContainer.replaceChildren(label, code, expiry);
        currentCodeContainer.hidden = false;
        pairButton.blur();
      };
      $("telegramTest").onclick = () => runTelegramAction(() => telegram.telegramTest(), "telegramTestSent");
      $("telegramDisconnect").onclick = () => {
        if (!window.confirm(t("telegramDisconnectConfirm"))) return;
        return runTelegramAction(() => telegram.telegramDisconnect(), "telegramDisconnected").then((result) => {
          if (result) state.telegramDraftDirty = false;
          return result;
        });
      };
      refreshTelegram();
      if (hasTelegramApi) state.telegramTimer = setInterval(() => refreshTelegram(false, true), 2000);
      $("executionConnect").onclick = configureExecution;
      $("zeroModeToggle").onclick = () => switchExecutionMode(executionState()?.mode === "server" ? "local" : "server");
      $("executionRetry").onclick = retryExecutionTransfer;
      paintExecution(execution);
      if (foot) {
        foot.hidden = false;
        foot.innerHTML = `
          <button type="button" class="ok" id="saveSet">${t("settingsSaveGroup")}</button>
          <button type="button" class="ghost" id="newSeries" hidden>${t("newSeries")}</button>
          <button type="button" class="ghost" id="resetPaper">${t("resetPaper")}</button>
        `;
      }
      state.paintSettingsSaveButton = (group = body.querySelector("[data-settings-tab].on")?.dataset.settingsTab || "strategy") => {
        const button = $("saveSet");
        if (!button) return;
        button.hidden = group === "polymarket" || group === "telegram";
        button.textContent = t("settingsSaveGroup");
        $("resetPaper").hidden = group !== "stakes";
        $("newSeries").hidden = group !== "stakes" || !canStartNewSeries(state.snapshot);
        if (foot) foot.hidden = [...foot.querySelectorAll("button")].every((item) => item.hidden);
      };
      state.paintSettingsSaveButton();
      updateSettingsLockUi(state.snapshot);
      const paintPlan = (snap) => {
        const box = $("planBox");
        const plan = snap && snap.plan;
        if (!box || !plan) return;
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        const stakes = steps
          .map((x) => `<span class="plan-step${x.winNet < 0 ? " neg" : ""}${x.capped ? " capped" : ""}" title="${esc(
            `${t("planWinNet")}: $${x.winNet.toFixed(2)}`
          )}">$${x.stake.toFixed(2)}</span>`)
          .join("");
        const worst = steps.reduce((m, x) => Math.min(m, x.winNet), Infinity);
        const quotePrice = snap.quote && snap.quote.ok && Number(snap.quote.price) > 0 ? Number(snap.quote.price) : 0;
        const price = quotePrice || Number(plan.price) || 0.5;
        box.innerHTML = `
          <div class="plan-head">${quotePrice ? t("planLiveQuote") : t("planEstimate")} ${price.toFixed(2)}</div>
          <div class="plan-steps">${stakes}</div>
          <div class="hint">${t("planAtRisk")}: <b>$${Number(plan.totalAtRisk || 0).toFixed(2)}</b> \u00b7 ${t("planBreakEven")}: <b>${(
            plan.breakEvenWinRate * 100
          ).toFixed(1)}%</b></div>
          ${plan.limitedByBudget ? `<div class="hint warn">${t("budgetLimited")}: $${Number(plan.budgetUsd || 0).toFixed(2)} · ${t("planStepsInBudget")}: ${steps.length} · ${t("planAtRisk")}: $${Number(plan.totalAtRisk || 0).toFixed(2)}</div>` : ""}
          ${worst < 0 ? `<div class="hint warn">${t("planNegative")}</div>` : ""}`;
      };
      state.paintPlan = paintPlan;
      paintPlan(state.snapshot);
      const planSave = (patch, ms) => {
        queueDebouncedSettings(patch, ms);
      };
      const fixedStakesPatch = () => ({ fixedStakes: $("fixedStakes").value });
      const updateSizingForm = () => {
        const mode = $("sizingSeg").querySelector("button.on")?.dataset.sizing || "double";
        const fixed = mode === "fixed";
        $("base").disabled = fixed;
        $("steps").disabled = fixed;
        $("fixedStakes").disabled = !fixed;
        $("fixedModeHint").hidden = !fixed;
        const warning = $("sizingWarning");
        warning.hidden = mode === "double";
        warning.textContent = mode === "fixed" ? t("fixedWarning") : mode === "recover" ? t("recoverWarning") : "";
      };
      $("sizingSeg").onclick = (e) => {
        const btn = e.target.closest("button[data-sizing]");
        if (!btn) return;
        for (const b of $("sizingSeg").querySelectorAll("button")) b.classList.toggle("on", b === btn);
        updateSizingForm();
        planSave({ sizingMode: btn.dataset.sizing, ...(btn.dataset.sizing === "fixed" ? fixedStakesPatch() : {}) }, 0);
      };
      updateSizingForm();
      const moneyOr = (el, fallback) => {
        if (!String(el.value).trim()) return 0;
        const n = Number(String(el.value).replace(",", "."));
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      $("maxStake").oninput = () => planSave({ maxStakeUsd: moneyOr($("maxStake"), 0) }, 400);
      $("dailyLimit").oninput = () => planSave({ dailyLossLimitUsd: moneyOr($("dailyLimit"), 0) }, 400);
      $("maxSeriesLoss").oninput = () => planSave({ maxSeriesLossUsd: moneyOr($("maxSeriesLoss"), 0) }, 400);
      $("dryRunToggle").onclick = async () => {
        const btn = $("dryRunToggle");
        const on = !btn.classList.contains("on");
        let snap;
        try {
          snap = await saveSettingsSerial({ dryRun: on });
        } catch (err) {
          settingError(localizedSettingsError(err));
          return;
        }
        // the engine refuses while a live bet is open; show what it kept
        const kept = snap && snap.settings ? snap.settings.dryRun !== false : on;
        btn.classList.toggle("on", kept);
        btn.setAttribute("aria-pressed", String(kept));
        if (snap) renderSnap(snap);
      };
      $("base").oninput = () => {
        planSave({ baseUsd: $("base").value }, 400);
      };
      $("steps").oninput = () => {
        planSave({ maxSteps: $("steps").value }, 400);
      };
      $("fixedStakes").oninput = () => planSave(fixedStakesPatch(), 400);
      $("maxEntry").value = String(Math.round((Number(s.maxEntryPrice) > 0 && Number(s.maxEntryPrice) < 1 ? Number(s.maxEntryPrice) : 1) * 100));
      const paintMaxEntry = () => {
        const v = Number($("maxEntry").value);
        $("maxEntryVal").textContent = v >= 100 ? t("off") : `\u2264 ${(v / 100).toFixed(2)}`;
      };
      paintMaxEntry();
      $("maxEntry").oninput = () => {
        paintMaxEntry();
        planSave({ maxEntryPrice: Number($("maxEntry").value) / 100 }, 150);
      };
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
      const crossMax = limits.minCrossTicks.max;
      $("crossTicks").max = String(crossMax);
      $("crossTicks").value = String(Math.max(0, Number(s.minCrossTicks || 0)));
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
      $("confirms").value = String(Math.max(limits.confirmCount.min, Math.min(limits.confirmCount.max, Number(s.confirmCount || 0))));
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
      $("fastPeriod").value = String(Number(s.fastPeriod || 20));
      $("slowPeriod").value = String(Number(s.slowPeriod || 200));
      const paintPeriods = () => {
        const fast = Number($("fastPeriod").value) || 20;
        const slow = Number($("slowPeriod").value) || 200;
        $("fastPeriodVal").textContent = `${t("fastGeneric")} ${fast}`;
        $("slowPeriodVal").textContent = `${t("slowGeneric")} ${slow}`;
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
        try {
          if (window.vespera) await saveSettingsSerial({ notificationsEnabled: on });
        } catch (err) {
          notifyBtn.classList.toggle("on", !on);
          notifyBtn.setAttribute("aria-pressed", String(!on));
          settingError(localizedSettingsError(err));
        }
      };
      const saveNow = async () => {
        if (state.savingPanel) return;
        const group = body.querySelector("[data-settings-tab].on")?.dataset.settingsTab || "strategy";
        const sizingMode = $("sizingSeg")?.querySelector("button.on")?.dataset.sizing || s.sizingMode || "double";
        const patchByGroup = {
          strategy: {
            minOpeningAtr: Number($("opening").value) / 20,
            minCrossTicks: Number($("crossTicks").value),
            confirmCount: Number($("confirms").value),
            fastPeriod: Number($("fastPeriod").value),
            slowPeriod: Number($("slowPeriod").value),
            fullBodyOnS: $("fullBodyToggle").classList.contains("on"),
            maType: $("maTypeSeg").querySelector("button.on")?.dataset.ma || s.maType || "SMA",
          },
          stakes: {
            sizingMode,
            ...(sizingMode === "fixed" ? fixedStakesPatch() : {
              maxSteps: Number($("steps").value),
              baseUsd: moneyOr($("base"), NaN).toFixed(2),
            }),
            maxStakeUsd: moneyOr($("maxStake"), 0),
            maxEntryPrice: Number($("maxEntry").value) / 100,
            dailyLossLimitUsd: moneyOr($("dailyLimit"), 0),
            maxSeriesLossUsd: moneyOr($("maxSeriesLoss"), 0),
          },
          execution: { dryRun: $("dryRunToggle").classList.contains("on") },
          interface: {
            refreshMs: Number($("refresh").value),
            notificationsEnabled: $("notifyToggle").classList.contains("on"),
          },
        };
        const groupPatch = patchByGroup[group];
        if (!groupPatch) {
          settingError(t("settingsSectionOwnSave"));
          return;
        }
        try {
          if (!window.vespera) return;
          state.savingPanel = true;
          await state.settingsSaveQueue.catch(() => {});
          const normalized = window.VesperaSettings.normalizeSettings(groupPatch, state.snapshot?.settings || s, { strict: true });
          const snap = await saveSettingsSerial(normalized);
          if (!snap || !snap.settings) throw new Error(t("settingsSaveFailed"));
          state.snapshot = snap;
          renderSnap(snap);
          hideTip();
        } catch (err) {
          settingError(localizedSettingsError(err), err && err.field);
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
      $("newSeries").onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = state.snapshot;
        if (!canStartNewSeries(current) || !window.vespera?.confirmLot) return;
        if (!window.confirm(t("newSeriesConfirm"))) return;
        try {
          const snap = await window.vespera.confirmLot(current.settings.baseUsd, { resetSeries: true });
          if (!snap || !snap.settings) throw new Error(t("settingsSaveFailed"));
          renderSnap(snap);
          openPanel("settings");
        } catch (err) {
          settingError(localizedSettingsError(err));
        }
      };
      body.oninput = (e) => {
        if (e.target && e.target.closest(".field")) clearSettingError();
      };
    }

    if (kind === "liveConfirm") {
      title.textContent = t("liveConfirmTitle");
      const snap = state.snapshot || {};
      const s = snap.settings || {};
      const plan = snap.plan || { steps: [], totalAtRisk: 0, price: 0.5 };
      const bal = snap.liveBalance && snap.liveBalance.source === "live" && snap.liveBalance.ok ? `$${snap.liveBalance.value}` : "\u2014";
      const wallet = s.walletAddress ? `${s.walletAddress.slice(0, 6)}\u2026${s.walletAddress.slice(-4)}` : "\u2014";
      const row = (k, v) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`;
      body.innerHTML = `
        <p class="hint warn">${t("liveConfirmLead")}</p>
        ${row(t("walletAddress"), esc(wallet))}
        ${row(t("walletType"), esc(({ DEPOSIT_WALLET: t("walletTypeDeposit"), POLY_PROXY: t("walletTypeProxy"), POLY_GNOSIS_SAFE: t("walletTypeSafe"), EOA: t("walletTypeEoa") })[
          (!s.walletType || s.walletType === "AUTO" ? s.detectedWalletType : s.walletType) || ""
        ] || t("walletTypeAuto")))}
        ${row(t("balance"), bal)}
        ${row(t("liveConfirmMarket"), esc(snap.pairLabel || ""))}
        ${row(t("sizing"), s.sizingMode === "fixed" ? t("sizingFixed") : s.sizingMode === "recover" ? t("sizingRecover") : t("sizingDouble"))}
        ${s.sizingMode === "fixed" ? row(t("fixedStakes"), (s.fixedStakes || []).map((value) => `$${Number(value).toFixed(2)}`).join(" · ")) : ""}
        ${row(t("liveConfirmStakes"), plan.steps.map((x) => `$${x.stake.toFixed(2)}`).join(" \u00b7 "))}
        ${row(t("planAtRisk"), `$${plan.totalAtRisk.toFixed(2)} @ ${plan.price.toFixed(2)}`)}
        ${row(t("maxStake"), Number(s.maxStakeUsd) > 0 ? `$${s.maxStakeUsd}` : t("maxStakeOff"))}
        ${row(t("maxSeriesLoss"), Number(s.maxSeriesLossUsd) > 0 ? `$${s.maxSeriesLossUsd}` : t("maxStakeOff"))}
        ${row(t("dailyLimit"), Number(s.dailyLossLimitUsd) > 0 ? `$${s.dailyLossLimitUsd}` : t("maxStakeOff"))}
        ${Number(s.dailyLossLimitUsd) > 0 ? "" : `<p class="hint warn">${t("liveConfirmNoLimit")}</p>`}
      `;
      if (foot) {
        foot.hidden = false;
        foot.innerHTML = `
          <button type="button" class="ok danger" id="liveGo">${t("liveConfirmGo")}</button>
          <button type="button" class="ghost" id="liveCancel">${t("cancel")}</button>
        `;
        $("liveCancel").onclick = () => closePanel();
        $("liveGo").onclick = async () => {
          closePanel();
          try {
            const res = await window.vespera.start({ confirmLive: true });
            if (res && res.ok === false) logNote(`${reasonText(res.reason)}${res.country ? ` (${res.country})` : ""}`);
          } catch (err) {
            logNote(`${t("logError")}: ${String((err && err.message) || err)}`);
          }
          renderSnap(await window.vespera.snapshot());
        };
      }
    }

    if (kind === "stats") {
      title.textContent = t("stats");
      const snap = state.snapshot || {};
      const r = snap.risk || {};
      const st = snap.stats || {};
      const pct = (x) => (x == null ? "\u2014" : `${(x * 100).toFixed(1)}%`);
      const usd = (x) => (x == null ? "\u2014" : `${x < 0 ? "\u2212" : ""}$${Math.abs(x).toFixed(2)}`);
      const edge = st.winRate != null && st.count >= 1 ? st.winRate - st.breakEvenWinRate : null;
      const row = (k, v, cls = "") => `<div class="stat-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
      const steps = (st.stepHits || [])
        .map((n, i) => `<span class="plan-step${i + 1 === r.maxSteps && n ? " neg" : ""}">${i + 1}: ${n}</span>`)
        .join("");
      body.innerHTML = `
        <p class="hint">${t(snap.book === "live" ? "statsHintLive" : snap.book === "dry" ? "statsHintDry" : "statsHintPaper")}</p>
        ${row(t("series"), `${r.step}/${r.maxSteps} \u00b7 $${r.size}${Number(r.seriesLossUsd) > 0 ? ` \u00b7 ${t("statsSeriesLoss")} $${r.seriesLossUsd}` : ""}`)}
        ${row(t("today"), usd(Number(snap.todayPnl)), Number(snap.todayPnl) < 0 ? "neg" : Number(snap.todayPnl) > 0 ? "pos" : "")}
        ${snap.mode === "auto" ? "" : row(t("balance"), `$${snap.paper?.balance}`)}
        <div class="stat-sep"></div>
        ${row(t("statsBets"), `${st.count || 0} (${st.wins || 0} / ${st.losses || 0})`)}
        ${row(t("statsWinRate"), pct(st.winRate), edge == null ? "" : edge >= 0 ? "pos" : "neg")}
        ${row(t("statsBreakEven"), `${pct(st.breakEvenWinRate)}${st.avgPrice ? ` @ ${st.avgPrice.toFixed(2)}` : ""}`)}
        ${row(t("statsPnl"), usd(st.pnl), st.pnl < 0 ? "neg" : st.pnl > 0 ? "pos" : "")}
        ${row(t("statsFees"), usd(st.fees))}
        ${row(t("statsRoi"), pct(st.roi), st.roi < 0 ? "neg" : "")}
        ${row(t("statsDrawdown"), usd(st.maxDrawdown))}
        ${row(t("statsLossStreak"), String(st.maxLossStreak || 0))}
        ${row(t("statsHalted"), String(st.seriesHalted || 0), st.seriesHalted ? "neg" : "")}
        <div class="field-label" style="margin-top:12px">${t("statsSteps")}</div>
        <div class="plan-steps">${steps}</div>
        ${st.count && st.count < 50 ? `<p class="hint">${t("statsFew")}</p>` : ""}
        <div class="field-label" style="margin-top:14px">${t("statsByDay")}</div>
        ${
          (snap.daily || []).length
            ? `<table class="day-table"><thead><tr><th>${t("statsDay")}</th><th>${t("statsBetsShort")}</th><th>${t("statsWinRate")}</th><th>${t("statsFees")}</th><th>${t("statsPnl")}</th></tr></thead><tbody>${snap.daily
                .map(
                  (d) =>
                    `<tr><td>${esc(d.day)}</td><td>${d.bets}</td><td>${pct(d.winRate)}</td><td>${usd(d.fees)}</td><td class="${d.pnl < 0 ? "neg" : d.pnl > 0 ? "pos" : ""}">${usd(d.pnl)}</td></tr>`
                )
                .join("")}</tbody></table>`
            : `<p class="hint">${t("logEmpty")}</p>`
        }
        <button type="button" class="ghost" id="btnExportCsv" style="margin-top:12px">${t("exportCsv")}</button>
        <p class="hint" id="exportOut">${t("exportCsvHint")}</p>
      `;
      $("btnExportCsv").onclick = async () => {
        const out = $("exportOut");
        const res = await window.vespera.exportCsv();
        if (res && res.ok) out.textContent = `${t("exportCsvDone")} ${res.count} \u2192 ${res.path}`;
        else if (res && res.reason === "canceled") out.textContent = t("exportCsvHint");
        else out.textContent = res && res.reason === "empty" ? t("exportCsvEmpty") : `${t("exportCsvFail")}: ${(res && res.reason) || ""}`;
      };
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
      if (window.vespera.getExecution) {
        try {
          state.execution = await window.vespera.getExecution();
          paintExecution();
        } catch {
          state.execution = null;
        }
      }
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
        if (evt.execution) {
          state.execution = evt.execution;
          if (state.snapshot) renderSnap({ ...state.snapshot, execution: evt.execution });
          else paintExecution(evt.execution);
        }
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
    $("backdrop").onclick = (e) => {
      openSheet(false);
      closePanel();
      // The backdrop covers the header while a panel is open; pass a click on a
      // header button (Start/Stop, Paper/Auto) through instead of swallowing it.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const hit = under && under.closest && under.closest(".chrome button");
      if (hit) hit.click();
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
      const btn = $("btnRun");
      if (btn.disabled) return;
      // Start can wait on candle history; show that the click landed.
      btn.disabled = true;
      try {
        if (state.running) {
          await window.vespera.stop();
        } else {
          const res = await window.vespera.start();
          if (res && res.reason === "live_confirm_required") {
            renderSnap(await window.vespera.snapshot());
            openPanel("liveConfirm");
            return;
          }
          if (res && res.ok === false) {
            logNote(res.reason === "daily_limit" ? t("dailyLimitHit") : `${reasonText(res.reason)}${res.country ? ` (${res.country})` : ""}${res.detail ? ` \u00b7 ${res.detail}` : ""}`);
          }
        }
      } catch (err) {
        logNote(`${t("logError")}: ${String((err && err.message) || err)}`);
      } finally {
        btn.disabled = false;
      }
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
