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
      const n = Number(row.pnl);
      detail = `${row.side || ""} · ${Number.isFinite(n) ? `${n < 0 ? "\u2212" : "+"}$${Math.abs(n).toFixed(2)}` : ""}`.trim();
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
    state.snapshot = snap;
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
          <div class="field">
            <label>${t("proxyUrl")}</label>
            <input id="proxyUrl" type="text" placeholder="${t("proxyPlaceholder")}" autocomplete="off" spellcheck="false" />
          </div>
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
      `;
      if (sApi.walletAddress) $("walletAddress").value = sApi.walletAddress;
      if (sApi.proxyUrl) {
        $("proxyUrl").value = sApi.proxyUrl;
        $("apiAdvanced").open = true;
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
            await window.vespera.saveSettings({ walletType: value });
            await refreshDetected();
          }
        )
      );
      paintWalletType();
      $("walletAddress").onchange = async () => {
        await window.vespera.saveSettings({ walletAddress: $("walletAddress").value.trim() });
        await refreshDetected();
      };

      const short = (a) => (a ? `${String(a).slice(0, 6)}\u2026${String(a).slice(-4)}` : "");
      const usd = (n) => `$${Number(n).toFixed(2)}`;
      const reasonOf = (c) => esc(c.reason || "");
      const checkText = (c) => {
        const x = {
          network: {
            ok: () => [t("chkNetworkOk"), c.latencyMs ? `${c.latencyMs} ms` : ""],
            fail: () => [c.blocked ? t("chkNetworkBlocked") : t("chkNetworkFail"), c.blocked ? t("chkNetworkBlockedFix") : reasonOf(c)],
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
        host.innerHTML = `
          <div class="chk-head" data-ready="${res.ready ? "1" : "0"}">${res.ready ? t("connectReady") : t("connectNotReady")}<span class="hint">${esc(when)}</span></div>
          ${rows}
          ${extra.map((e) => `<p class="hint warn">${e}</p>`).join("")}`;
      };
      paintChecks(state.snapshot?.lastConnect);
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
        <div class="field toggle-row">
          <span class="field-label">${t("sizing")}${helpBtn("sizingHint")}</span>
          <div class="seg seg-sm" id="sizingSeg">
            <button type="button" data-sizing="double" class="${(s.sizingMode || "double") === "double" ? "on" : ""}">\u00d72</button>
            <button type="button" data-sizing="recover" class="${s.sizingMode === "recover" ? "on" : ""}">${t("sizingRecover")}</button>
          </div>
        </div>
        <div class="field"><span class="field-label">${t("maxStake")}${helpBtn("maxStakeHint")}</span><input id="maxStake" inputmode="decimal" value="${Number(s.maxStakeUsd) > 0 ? s.maxStakeUsd : ""}" placeholder="${t("maxStakeOff")}" /></div>
        <div class="field">
          <span class="field-label">${t("maxEntryPrice")}${helpBtn("maxEntryPriceHint")}</span>
          <div class="range-row">
            <input id="maxEntry" type="range" min="50" max="100" step="1" />
            <span class="range-val" id="maxEntryVal"></span>
          </div>
        </div>
        <div class="plan-box" id="planBox"></div>
        <div class="field"><span class="field-label">${t("dailyLimit")}${helpBtn("dailyLimitHint")}</span><input id="dailyLimit" inputmode="decimal" value="${Number(s.dailyLossLimitUsd) > 0 ? s.dailyLossLimitUsd : ""}" placeholder="${t("maxStakeOff")}" /></div>
        <div class="field toggle-row">
          <span class="field-label">${t("dryRun")}${helpBtn("dryRunHint")}</span>
          <button type="button" class="toggle ${s.dryRun !== false ? "on" : ""}" id="dryRunToggle" aria-pressed="${s.dryRun !== false}">
            <span class="knob"></span>
          </button>
        </div>
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
      const paintPlan = (snap) => {
        const box = $("planBox");
        const plan = snap && snap.plan;
        if (!box || !plan) return;
        const stakes = plan.steps
          .map((x) => `<span class="plan-step${x.winNet < 0 ? " neg" : ""}${x.capped ? " capped" : ""}" title="${esc(
            `${t("planWinNet")}: $${x.winNet.toFixed(2)}`
          )}">$${x.stake.toFixed(2)}</span>`)
          .join("");
        const worst = plan.steps.reduce((m, x) => Math.min(m, x.winNet), Infinity);
        box.innerHTML = `
          <div class="plan-head">${t("planTitle")} ${plan.price.toFixed(2)}</div>
          <div class="plan-steps">${stakes}</div>
          <div class="hint">${t("planAtRisk")}: <b>$${plan.totalAtRisk.toFixed(2)}</b> \u00b7 ${t("planBreakEven")}: <b>${(
            plan.breakEvenWinRate * 100
          ).toFixed(1)}%</b></div>
          ${worst < 0 ? `<div class="hint warn">${t("planNegative")}</div>` : ""}`;
      };
      paintPlan(state.snapshot);
      const planSave = (patch, ms) => {
        clearTimeout(state.planTimer);
        state.planTimer = setTimeout(async () => {
          if (!window.vespera) return;
          const snap = await window.vespera.saveSettings(patch);
          if (snap) {
            state.snapshot = snap;
            paintPlan(snap);
          }
        }, ms);
      };
      $("sizingSeg").onclick = (e) => {
        const btn = e.target.closest("button[data-sizing]");
        if (!btn) return;
        for (const b of $("sizingSeg").querySelectorAll("button")) b.classList.toggle("on", b === btn);
        planSave({ sizingMode: btn.dataset.sizing }, 0);
      };
      const moneyOr = (el, fallback) => {
        const n = Number(String(el.value).replace(",", "."));
        return Number.isFinite(n) && n >= 0 ? n : fallback;
      };
      $("maxStake").oninput = () => planSave({ maxStakeUsd: moneyOr($("maxStake"), 0) }, 400);
      $("dailyLimit").oninput = () => planSave({ dailyLossLimitUsd: moneyOr($("dailyLimit"), 0) }, 400);
      $("dryRunToggle").onclick = async () => {
        const btn = $("dryRunToggle");
        const on = !btn.classList.contains("on");
        const snap = await window.vespera.saveSettings({ dryRun: on });
        // the engine refuses while a live bet is open; show what it kept
        const kept = snap && snap.settings ? snap.settings.dryRun !== false : on;
        btn.classList.toggle("on", kept);
        btn.setAttribute("aria-pressed", String(kept));
        if (snap) renderSnap(snap);
      };
      $("base").oninput = () => {
        const n = moneyOr($("base"), 0);
        if (n > 0) planSave({ baseUsd: n.toFixed(2) }, 400);
      };
      $("steps").oninput = () => {
        const n = Math.round(moneyOr($("steps"), 0));
        if (n >= 1 && n <= 20) planSave({ maxSteps: n }, 400);
      };
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
          sizingMode: (document.querySelector("#sizingSeg button.on") || {}).dataset?.sizing || s.sizingMode || "double",
          maxStakeUsd: $("maxStake") ? moneyOr($("maxStake"), 0) : Number(s.maxStakeUsd) || 0,
          maxEntryPrice: $("maxEntry") ? Number($("maxEntry").value) / 100 : Number(s.maxEntryPrice) || 1,
          dailyLossLimitUsd: $("dailyLimit") ? moneyOr($("dailyLimit"), 0) : Number(s.dailyLossLimitUsd) || 0,
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
        ${row(t("sizing"), s.sizingMode === "recover" ? t("sizingRecover") : "\u00d72")}
        ${row(t("liveConfirmStakes"), plan.steps.map((x) => `$${x.stake.toFixed(2)}`).join(" \u00b7 "))}
        ${row(t("planAtRisk"), `$${plan.totalAtRisk.toFixed(2)} @ ${plan.price.toFixed(2)}`)}
        ${row(t("maxStake"), Number(s.maxStakeUsd) > 0 ? `$${s.maxStakeUsd}` : t("maxStakeOff"))}
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
          const res = await window.vespera.start({ confirmLive: true });
          if (res && res.ok === false) logNote(reasonText(res.reason));
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
      if (state.running) {
        await window.vespera.stop();
      } else {
        const res = await window.vespera.start();
        if (res && res.reason === "live_confirm_required") {
          renderSnap(await window.vespera.snapshot());
          openPanel("liveConfirm");
          return;
        }
        if (res && res.reason === "daily_limit") logNote(t("dailyLimitHit"));
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
