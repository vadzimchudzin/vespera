(() => {
  const $ = (id) => document.getElementById(id);
  const t = (key) => (window.VSP_I18N[state.locale] || window.VSP_I18N.en)[key] || key;

  const state = {
    locale: "en",
    theme: "glass-dark",
    running: false,
    mode: "paper",
    snapshot: null,
  };

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.documentElement.lang = state.locale;
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
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

  function renderSnap(snap) {
    if (!snap) return;
    state.snapshot = snap;
    state.running = snap.running;
    state.mode = snap.mode;
    $("statusPill").textContent = statusLabel(snap.status);
    $("bal").textContent = `$${Number(snap.paper.balance).toLocaleString(undefined, {
      minimumFractionDigits: 2,
    })}`;
    $("series").textContent = `${snap.risk.step}/${snap.risk.maxSteps} · $${snap.risk.size}`;
    const pnl = Number(snap.todayPnl);
    $("pnl").textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    $("pnl").style.color = pnl >= 0 ? "var(--accent)" : "var(--danger)";
    $("btnRun").textContent = snap.running ? t("stop") : t("start");
    $("btnRun").classList.toggle("stop", snap.running);
    document.querySelectorAll("#modeSeg button").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === snap.mode);
    });
    renderStrategies(snap);
    if (window.VesperaChart) window.VesperaChart.render(snap);
    const log = $("log");
    log.innerHTML = "";
    const rows = snap.log || [];
    if (!rows.length) {
      log.textContent = t("logEmpty");
      return;
    }
    rows.slice(0, 12).forEach((row) => {
      const div = document.createElement("div");
      const when = (row.ts || "").slice(11, 19);
      div.textContent = `${when}  ${row.type}${row.reason ? " · " + row.reason : ""}${
        row.side ? " · " + row.side : ""
      }${row.sizeUsd ? " · $" + row.sizeUsd : ""}`;
      log.appendChild(div);
    });
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
          div.textContent = t("strategyBlocked");
          log.prepend(div);
        }
      };
      host.appendChild(btn);
    });
  }

  function openSheet(show) {
    $("sheet").hidden = !show;
    $("backdrop").hidden = !show;
  }

  function openPanel(kind) {
    const body = $("panelBody");
    const title = $("panelTitle");
    $("panel").hidden = false;
    $("backdrop").hidden = false;
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
      if (ping?.live) {
        $("pingOut").textContent = ping.live.message || "";
      }
    }
    if (kind === "theme") {
      title.textContent = t("theme");
      body.innerHTML = `
        <div class="field">
          <label>${t("theme")}</label>
          <select id="themeSel">
            <option value="glass-dark">${t("glassDark")}</option>
            <option value="glass-light">${t("glassLight")}</option>
          </select>
        </div>
        <button class="ok" id="saveTheme">${t("ping")}</button>
      `;
      $("themeSel").value = state.theme;
      $("saveTheme").onclick = async () => {
        state.theme = $("themeSel").value;
        applyTheme();
        await window.vespera.saveSettings({ theme: state.theme });
        $("panel").hidden = true;
        $("backdrop").hidden = true;
      };
    }
    if (kind === "language") {
      title.textContent = t("language");
      body.innerHTML = `
        <div class="field">
          <label>${t("language")}</label>
          <select id="langSel">
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </select>
        </div>
        <button class="ok" id="saveLang">${t("ping")}</button>
      `;
      $("langSel").value = state.locale;
      $("saveLang").onclick = async () => {
        state.locale = $("langSel").value;
        applyI18n();
        await window.vespera.saveSettings({ locale: state.locale });
        renderSnap(state.snapshot);
        $("panel").hidden = true;
        $("backdrop").hidden = true;
      };
    }
    if (kind === "settings") {
      title.textContent = t("settings");
      const s = state.snapshot?.settings || {};
      body.innerHTML = `
        <div class="field"><label>${t("symbol")}</label><input id="sym" value="${s.symbol || "BTCUSDT"}" /></div>
        <div class="field"><label>${t("timeframe")}</label>
          <select id="tf">
            <option>15m</option><option>5m</option><option>1h</option>
          </select>
        </div>
        <div class="field"><label>${t("base")}</label><input id="base" value="${s.baseUsd || "1.00"}" /></div>
        <div class="field"><label>${t("maxSteps")}</label><input id="steps" value="${s.maxSteps || 6}" /></div>
        <button class="ok" id="saveSet">${t("confirmLot")}</button>
      `;
      $("tf").value = s.timeframe || "15m";
      $("saveSet").onclick = async () => {
        const baseUsd = $("base").value;
        await window.vespera.saveSettings({
          symbol: $("sym").value,
          timeframe: $("tf").value,
          maxSteps: Number($("steps").value),
          baseUsd,
        });
        await window.vespera.confirmLot(baseUsd);
        $("panel").hidden = true;
        $("backdrop").hidden = true;
      };
    }
    if (kind === "stats") {
      title.textContent = t("stats");
      const r = state.snapshot?.risk || {};
      body.innerHTML = `<p>${t("series")}: ${r.step}/${r.maxSteps}</p>
        <p>${t("today")}: $${state.snapshot?.todayPnl}</p>
        <p>${t("balance")}: $${state.snapshot?.paper?.balance}</p>`;
    }
    if (kind === "journal") {
      title.textContent = t("journal");
      const rows = (state.snapshot?.log || []).slice(0, 30);
      body.innerHTML = rows
        .map((row) => `<div class="hint">${row.ts} · ${row.type} ${row.reason || row.side || ""}</div>`)
        .join("") || `<p class="hint">${t("logEmpty")}</p>`;
    }
    if (kind === "feed") {
      title.textContent = t("feed");
      const ev = state.snapshot?.lastEval;
      body.innerHTML = ev
        ? `<p>${ev.reason}</p><p>MA20 ${ev.ma20?.toFixed?.(2) || "—"} · MA200 ${ev.ma200?.toFixed?.(2) || "—"}</p>`
        : `<p class="hint">${t("logEmpty")}</p>`;
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
        if (evt.state) renderSnap(evt.state);
      });
    } else {
      applyI18n();
    }
    if (navigator.userAgent.includes("Windows")) document.body.classList.add("win");

    $("btnMenu").onclick = () => openSheet(true);
    $("sheetClose").onclick = () => openSheet(false);
    $("backdrop").onclick = () => {
      openSheet(false);
      $("panel").hidden = true;
      $("backdrop").hidden = true;
    };
    $("panelClose").onclick = () => {
      $("panel").hidden = true;
      $("backdrop").hidden = true;
    };
    document.querySelectorAll(".row[data-open]").forEach((btn) => {
      btn.onclick = () => {
        openSheet(false);
        openPanel(btn.dataset.open);
      };
    });
    document.querySelectorAll(".rail-item").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".rail-item").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        if (btn.dataset.panel !== "feed") openPanel(btn.dataset.panel);
        else {
          $("panel").hidden = true;
          $("backdrop").hidden = true;
        }
      };
    });
    document.querySelectorAll("#modeSeg button").forEach((btn) => {
      btn.onclick = async () => {
        if (window.vespera) await window.vespera.setMode(btn.dataset.mode);
        state.mode = btn.dataset.mode;
        document.querySelectorAll("#modeSeg button").forEach((b) =>
          b.classList.toggle("on", b.dataset.mode === state.mode)
        );
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
  }

  boot();
})();
