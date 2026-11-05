// The "Agents" panel: paper agents on Polymarket. It adds its own rail button and overlay and talks only to
// window.vespera.agents*; app.js is untouched. Every value from the desk is written as text, never as markup.
(() => {
  "use strict";
  const api = window.vespera;
  if (!api || typeof api.agentsStatus !== "function") return;

  const POLL_MS = 5000;
  const isRu = () => /^ru/i.test(document.documentElement.lang || "");
  const say = (ru, en) => (isRu() ? ru : en);
  const pick = (pair) => (Array.isArray(pair) ? say(pair[0], pair[1]) : String(pair));

  // ---- DOM: text only -------------------------------------------------------------------------------------------
  const PROPS = new Set(["value", "checked", "disabled", "hidden", "title", "type"]);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "on") for (const [name, fn] of Object.entries(value)) el.addEventListener(name, fn);
      else if (PROPS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  // ---- formatting -----------------------------------------------------------------------------------------------
  const grouped = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  // U+2060 (word joiner) keeps a sign on the same line as its amount: "−" and "$" are both break opportunities.
  const usd = (x, d = 2) => { const v = Number(x) || 0; return `${v < 0 ? "−\u2060" : ""}$${grouped(Math.abs(v).toFixed(d))}`; };
  const signed = (x) => { const v = Number(x) || 0; return `${v > 0.004 ? "+\u2060" : v < -0.004 ? "−\u2060" : ""}$${grouped(Math.abs(v).toFixed(2))}`; };
  const pct = (x, d = 1) => { const v = (Number(x) || 0) * 100, t = Math.abs(v).toFixed(d); return `${v < 0 && Number(t) !== 0 ? "−" : ""}${t}%`; };
  const tone = (x) => (Number(x) > 0.004 ? "pos" : Number(x) < -0.004 ? "neg" : "");
  const cents = (p) => (p == null || !Number.isFinite(Number(p)) ? "—" : `${(Number(p) * 100).toFixed(1)}¢`);
  const shares = (x) => (Number(x) || 0).toFixed(Number(x) >= 100 ? 0 : 1);
  const when = (t) => (typeof t === "number" ? t : Date.parse(t || ""));
  const locale = () => (isRu() ? "ru-RU" : "en-GB");
  const time = (t) => (Number.isFinite(when(t)) ? new Date(when(t)).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "—");
  const stamp = (t) => (Number.isFinite(when(t)) ? new Date(when(t)).toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const codeOf = (error) => {
    const m = /([a-z][a-z0-9_]{2,63})\s*$/.exec(String((error && (error.code || error.message)) || ""));
    return m ? m[1] : "agents_unavailable";
  };

  const TYPES = {
    arb_bundle: ["Арбитраж наборов", "Bundle arbitrage"], arb_ladder: ["Арбитраж лесенок", "Ladder arbitrage"],
    crypto_levels: ["Крипто-уровни", "Crypto levels"], weather: ["Погода", "Weather"], favorites: ["Фавориты", "Favourites"],
    resolution: ["Близкий итог", "Near resolution"], forecast: ["Прогнозист", "Forecaster"], maker: ["Мейкер (тень)", "Maker (shadow)"],
    latency: ["Латентный арбитраж", "Latency arbitrage"], lp_rewards: ["LP с наградами", "LP with rewards"],
  };
  const typeName = (t) => (TYPES[t] ? pick(TYPES[t]) : String(t || "?"));
  const HALTS = { manual: ["ручная остановка", "manual stop"], daily_loss: ["дневной убыток", "daily loss"], drawdown: ["просадка от пика", "drawdown from the peak"] };
  const haltName = (r) => (HALTS[r] ? pick(HALTS[r]) : String(r || "?"));
  const STATUS = { active: ["в работе", "active"], paused: ["пауза", "paused"], retired: ["выведен", "retired"] };
  const VERDICT = { traded: ["сделка", "traded"], skipped: ["пропуск", "skipped"], queued: ["в очереди", "queued"] };
  const OPS = { pause: ["пауза", "paused"], resume: ["снова в работе", "back"], retire: ["выведен", "retired"], spawn: ["новый", "new"] };
  const BY = { ui: ["приложение", "the app"], telegram: ["Telegram", "Telegram"], rules: ["правила", "rules"], ai: ["ИИ", "AI"], new_day: ["новые сутки", "new day"] };
  const byName = (b) => (BY[b] ? pick(BY[b]) : String(b || "?"));
  const NOTES = {
    loss_30: ["убыток 30% капитала агента", "a loss of 30% of the agent's capital"],
    loss_10_after_20: ["убыток 10% после 20 сделок", "a loss of 10% after 20 trades"],
    brier_worse_than_market: ["прогнозы хуже рынка (Brier)", "forecasts worse than the market (Brier)"],
    retest_after_72h: ["повторная проверка через 72 ч", "retest after 72 h"], ai_plan: ["по плану ИИ", "on the AI's plan"],
    manual: ["вручную", "by hand"], initial: ["стартовый состав", "the starting roster"],
    replaced_by_lp: ["заменён агентом «LP с наградами»", "replaced by LP with rewards"],
    v2_kill_switch: ["правило остановки V2: выход ≤ 0 после 500 сделок", "the V2 kill switch: an exit ≤ 0 after 500 trades"],
  };
  const noteText = (n) => { const v = /^variant_of_(a\d+)$/.exec(n || ""); return v ? say(`вариант ${v[1]}`, `a variant of ${v[1]}`) : NOTES[n] ? pick(NOTES[n]) : String(n || ""); };
  const REASONS = {
    agents_halted: ["Сначала снимите стоп.", "Clear the halt first."],
    agents_reset_required: ["Капитал меняется только через «Начать заново»: сделки уже были.", "Capital changes only with Start afresh: there are trades already."],
    agents_live_requires_certificate: ["Реальные деньги недоступны: нужен сертификат (M6). Агенты торгуют только на бумаге.", "Real money is unavailable: it needs the certificate (M6). Agents trade on paper only."],
    agents_config_invalid: ["Проверьте значения: одно из них вне допустимых пределов.", "Check the values: one is out of range."],
    agents_confirmation_required: ["Нужно подтверждение.", "Confirmation required."],
    agents_disposed: ["Агенты выключены.", "Agents are off."], agents_unavailable: ["Агенты недоступны.", "Agents are unavailable."],
    agents_store_corrupt: ["Файл агентов повреждён.", "The agents' file is damaged."],
    agents_store_unwritable: ["Не удаётся записать файл агентов.", "The agents' file cannot be written."],
    agents_agent_not_found: ["Агент не найден.", "Agent not found."], agents_agent_not_active: ["Агент уже не в работе.", "The agent is not active."],
    agents_agent_not_paused: ["Агент не на паузе.", "The agent is not paused."],
    agents_lane_no_websocket: ["Нет WebSocket для быстрой полосы.", "No WebSocket for the fast lane."],
    agents_lane_no_markets: ["Нет подходящих рынков с наградами; новая попытка через 10 минут.", "No suitable reward markets; another try in 10 minutes."],
    agents_lane_universe_failed: ["Не удалось собрать рынки с наградами; новая попытка через 10 минут.", "Could not build the reward markets; another try in 10 minutes."],
    agents_lane_poll_failed: ["Сбой опроса стаканов; полоса продолжает.", "A book poll failed; the lane goes on."],
    agents_lane_store_failed: ["Не удаётся записать счёт полосы.", "The lane's ledger cannot be written."],
    agents_lane_status_failed: ["Полоса не отвечает.", "The lane does not answer."],
    agents_reset_scope_invalid: ["Неизвестно, что начинать заново.", "Unknown reset scope."],
    agents_open_failed: ["Не удалось открыть папку.", "The folder could not be opened."],
    not_server_owner: ["Сервер сейчас не ведёт исполнение.", "The server does not own execution now."],
    handoff_pending: ["Идёт передача между компьютером и сервером.", "A handoff between the desktop and the server is in progress."],
    remote_unavailable: ["Сервер недоступен.", "The server is unavailable."],
  };
  const reason = (c) => (REASONS[c] ? pick(REASONS[c]) : String(c || say("неизвестная ошибка", "unknown error")));
  const AI_REASONS = {
    agents_ai_off: ["выключен в настройках агентов", "off in the agents' settings"], agents_ai_budget_zero: ["бюджет агентов на ИИ — $0", "the agents' AI budget is $0"],
    agents_ai_budget_used: ["дневной бюджет исчерпан", "the daily budget is used up"], ai_disabled: ["ИИ-помощник выключен", "the AI advisor is off"],
    ai_key_missing: ["нет ключа OpenRouter", "no OpenRouter key"], ai_agents_openrouter_only: ["нужен OpenRouter, локальная модель не подходит", "needs OpenRouter, not a local model"],
    ai_unavailable: ["недоступен", "unavailable"],
  };
  const aiReason = (c) => (AI_REASONS[c] ? pick(AI_REASONS[c]) : String(c || "—"));

  // ---- V2: the lanes' own paper account and their certificates ---------------------------------------------------
  const V2_VERDICT = { collecting: ["идёт сбор", "collecting", ""], pass: ["пройден", "passed", "pos"], fail: ["не пройден", "failed", "neg"],
    kill: ["остановлен правилом", "stopped by the kill switch", "neg"] };
  const verdictOf = (v) => V2_VERDICT[v] || V2_VERDICT.collecting;
  const verdictChip = (v) => h("span", { class: `ag-chip ${verdictOf(v)[2]}` }, say(verdictOf(v)[0], verdictOf(v)[1]));
  const WATCH = { down: ["не работает", "is down"], binance: ["нет данных Binance", "no data from Binance"], clob: ["нет стаканов Polymarket", "no Polymarket order books"],
    books: ["не приходят стаканы", "no order books"], rtds: ["нет ленты сделок Polymarket", "no Polymarket trade feed"] };
  const watchName = (c) => (WATCH[c] ? pick(WATCH[c]) : String(c || "?"));
  const finite = (x) => x != null && Number.isFinite(Number(x));
  const perShare = (x) => (finite(x) ? `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(2)}¢` : "—");
  const fixed = (x, d = 2) => (finite(x) ? Number(x).toFixed(d) : "—");
  const pv = (p) => (!finite(p) ? "—" : p < 0.001 ? "< 0.001" : Number(p).toFixed(3));
  const count = (x) => grouped(String(Math.round(Number(x) || 0)));
  function v2EventText(r) {
    if (r.op === "v2_kill") return say(`правило остановки — после ${count(r.trades)} сделок BTC 5m выход ${perShare(r.exit)}/акц.; агент на паузе`,
      `kill switch — after ${count(r.trades)} BTC 5m trades the exit is ${perShare(r.exit)}/share; the agent is paused`);
    if (r.op === "v2_verdict") return `${say("вердикт", "verdict")}: ${pick(verdictOf(r.verdict))} · ${say(`${count(r.trades)} сделок BTC 5m, выход ${perShare(r.exit)}/акц., p ${pv(r.p)}`, `${count(r.trades)} BTC 5m trades, exit ${perShare(r.exit)}/share, p ${pv(r.p)}`)}`;
    if (r.op === "v2_phase") return say(`фаза ${r.phase} закрыта ${r.ok ? "✓" : "×"} — итог ${signed(r.net)}, крупнейший рынок ${finite(r.topShare) ? pct(r.topShare, 0) : "—"}${finite(r.shieldT) ? `, щит t ${r.shieldT}` : ""}`,
      `phase ${r.phase} closed ${r.ok ? "✓" : "×"} — net ${signed(r.net)}, top market ${finite(r.topShare) ? pct(r.topShare, 0) : "—"}${finite(r.shieldT) ? `, shield t ${r.shieldT}` : ""}`);
    return String(r.op || "");
  }

  function journalText(r) {
    const who = r.agentId ? `${r.agentId} ${typeName(r.type)}` : "";
    switch (r.kind) {
      case "trade": return `${say("Сделка", "Trade")} · ${who}: ${r.outcome} «${r.label}»${r.legs > 1 ? say(` (${r.legs} ног)`, ` (${r.legs} legs)`) : ""} ${usd(r.costUsd)}${r.avg ? ` @ ${Number(r.avg).toFixed(3)}` : ""}${r.edge != null ? ` · ${say("перевес", "edge")} ${pct(r.edge)}` : ""}`;
      case "settle": return `${say("Итог", "Settled")} · ${who}: ${r.outcome} «${r.label}» → ${signed(r.pnl)}`;
      case "start": return say(`Старт (${byName(r.by)})`, `Started (${byName(r.by)})`);
      case "stop": return say(`Стоп (${byName(r.by)})`, `Stopped (${byName(r.by)})`);
      case "halt": return `${say("Стоп", "Halt")}: ${haltName(r.reason)}${r.equity != null ? ` · ${usd(r.equity)} ≤ ${usd(r.limit)}` : ""} (${byName(r.by)})`;
      case "halt_clear": return say(`Стоп снят: ${haltName(r.reason)} (${byName(r.by)})`, `Halt cleared: ${haltName(r.reason)} (${byName(r.by)})`);
      case "config": return `${say("Настройки", "Settings")}: ${(r.changed || []).join(", ")}`;
      case "reset": return r.scope === "v2" ? say("V2 начат заново: новые счёт и сертификаты a9 и a10", "V2 started afresh: a new account and certificates for a9 and a10")
        : say(`Начато заново с ${usd(r.capitalUsd, 0)}`, `Started afresh with ${usd(r.capitalUsd, 0)}`);
      case "v2": return `V2 · ${who}: ${v2EventText(r)}`;
      case "watch": return r.state === "ok" ? `${say("Контроль", "Watch")} · ${who}: ${say("снова в порядке", "back to normal")} (${say("было", "was")}: ${watchName(r.code)})`
        : `${say("Контроль", "Watch")} · ${who}: ${watchName(r.code)} ${say("дольше 3 мин", "for over 3 min")}${r.error ? ` (${reason(r.error)})` : ""}`;
      case "roster": return `${say("Состав", "Roster")} · ${who}: ${OPS[r.op] ? pick(OPS[r.op]) : r.op}${r.reason ? ` — ${noteText(r.reason)}` : ""}`;
      case "ai": return `${say("ИИ", "AI")} · ${r.task}${r.answered != null ? `: ${r.answered}/${r.asked}` : ""}${Array.isArray(r.applied) && r.applied.length ? `: ${r.applied.join(", ")}` : ""} · ${usd(r.costUsd, 4)}`;
      case "ai_error": return `${say("ИИ: ошибка", "AI error")} ${r.code || ""}`;
      case "lane":
        if (r.op === "start") return `${who}: ${say("запущен", "started")}`;
        if (r.op === "stop") return `${who}: ${say("остановлен", "stopped")}`;
        if (r.op === "day_stop") return `${who}: ${say(`дневной лимит убытка ${signed(r.limit)} — пауза до конца суток UTC`, `daily loss limit ${signed(r.limit)} — paused until the UTC day ends`)}`;
        return `${who} · ${say("за час", "the hour")}: ${signed(r.pnl)} · ${say("сделок", "trades")} ${r.trades ?? 0}`;
      default: return String(r.kind || "");
    }
  }

  // ---- settings form --------------------------------------------------------------------------------------------
  const FIELDS = [
    ["capitalUsd", "Капитал, $", "Capital, $"], ["perTradeUsd", "На сделку, $", "Per trade, $"],
    ["perMarketUsd", "На рынок, $", "Per market, $"], ["perEventUsd", "На событие, $", "Per event, $"],
    ["sectorMaxPct", "На сектор, % капитала", "Per sector, % of capital"], ["exposureMaxPct", "Всего в позициях, %", "Total exposure, %"],
    ["dailyLossPct", "Стоп: дневной убыток, %", "Halt: daily loss, %"], ["drawdownPct", "Стоп: просадка от пика, %", "Halt: drawdown, %"],
    ["kellyFraction", "Доля Келли", "Kelly fraction"], ["minEdgePct", "Мин. перевес, %", "Min edge, %"],
    ["arbMinPct", "Мин. арбитраж, %", "Min arbitrage, %"], ["arbMinUsd", "Мин. арбитраж, $", "Min arbitrage, $"],
    ["maxAgents", "Агентов не больше", "Max agents"], ["agentCapitalPct", "Капитал агента, %", "Agent capital, %"],
    ["aiDailyUsd", "ИИ: бюджет в сутки, $", "AI: daily budget, $"], ["aiEveryMin", "ИИ: не чаще, мин", "AI: at most every, min"],
    ["topEvents", "Событий в работе", "Events in play"], ["refreshMin", "Обновлять рынки, мин", "Refresh markets, min"],
    ["digestMin", "Сводка в Telegram, мин (0 — сразу)", "Telegram digest, min (0 — at once)"], ["reportHourUtc", "Отчёт за сутки, час UTC", "Daily report, UTC hour"],
  ];
  const TOGGLES = [["aiEnabled", "ИИ для агентов", "AI for the agents"], ["notifyTrades", "Сделки в Telegram", "Trades to Telegram"]];
  const TABS = [["agents", ["Агенты", "Agents"]], ["v2", ["V2", "V2"]], ["positions", ["Позиции", "Positions"]], ["candidates", ["Кандидаты", "Candidates"]],
    ["journal", ["Журнал", "Journal"]], ["report", ["Отчёт", "Report"]], ["settings", ["Настройки", "Settings"]]];

  const ui = { open: false, s: null, tab: "agents", timer: 0, seq: 0, rseq: 0, busy: false, msg: null, msgTimer: 0, period: "day", report: null, resetAsk: false, resetCapital: 1000, side: null, v2Ask: false };
  let rail = null, railText = null, shade = null, panel = null, els = null;

  // ---- pieces ---------------------------------------------------------------------------------------------------
  const empty = (text) => h("div", { class: "ag-empty" }, text);
  const card = (label, value, sub, cls) => h("div", { class: "ag-card" }, h("div", { class: "ag-card-label" }, label),
    h("div", { class: `ag-card-value ${cls || ""}` }, value), sub ? h("div", { class: "ag-card-sub" }, sub) : null);
  const stat = (label, value, cls) => h("span", { class: "ag-stat" }, h("span", { class: "ag-muted" }, `${label} `), h("span", { class: cls || "" }, String(value)));
  const button = (label, cls, fn, title) => h("button", { class: cls, type: "button", title, disabled: ui.busy, on: { click: fn } }, label);
  function table(head, rows) {
    return h("div", { class: "ag-table-wrap" }, h("table", { class: "ag-table" },
      h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))),
      h("tbody", null, rows.map((r) => h("tr", null, r.map((x) => h("td", null, x)))))));
  }

  function headEl() {
    const s = ui.s;
    const chip = !s ? ["…", ""] : s.ok === false || s.error ? [say("недоступны", "unavailable"), "neg"]
      : s.halt ? [`${say("стоп", "halted")}: ${haltName(s.halt.reason)}`, "neg"] : s.running ? [say("работают", "running"), "pos"] : [say("остановлены", "stopped"), ""];
    const where = ui.side === "server" ? say("на сервере", "on the server") : ui.side === "local" ? say("на этом компьютере", "on this computer") : "";
    return h("header", { class: "ag-head" },
      h("div", { class: "ag-title" }, h("h2", null, say("Агенты", "Agents")), h("span", { class: `ag-chip ${chip[1]}` }, chip[0])),
      h("div", { class: "ag-sub" }, say("Бумажная торговля на Polymarket — реальные деньги не используются", "Paper trading on Polymarket — no real money is used") + (where ? ` · ${where}` : "")),
      h("button", { class: "orb sm ag-close", type: "button", title: say("Закрыть", "Close"), on: { click: () => close() } }, "✕"));
  }

  function topEl() {
    const s = ui.s, box = h("div", { class: "ag-top" });
    if (ui.msg) box.append(h("div", { class: `ag-msg ${ui.msg.tone || ""}` }, ui.msg.text));
    if (!s) return box.append(empty(say("Загрузка…", "Loading…"))), box;
    if (s.ok === false) {
      box.append(h("div", { class: "ag-alert" }, reason(s.reason), h("div", { class: "btn-row" }, button(say("Повторить", "Retry"), "ghost", () => refresh()))));
      return box;
    }
    if (s.error) {
      box.append(h("div", { class: "ag-alert" }, h("strong", null, `${reason(s.error)} `),
        say("Он не будет перезаписан: «Начать заново» отложит его рядом и откроет новый бумажный счёт.", "It is never written over: Start afresh moves it aside and opens a new paper book."), resetEl()));
      return box;
    }
    const row = h("div", { class: "ag-controls" });
    if (s.halt) row.append(button(say("Снять стоп", "Clear halt"), "ok", () => act("agentsResume")));
    else if (s.running) row.append(button(say("Стоп", "Stop"), "ghost", () => act("agentsStop")));
    else row.append(button(say("Старт", "Start"), "ok", () => act("agentsStart")));
    if (!s.halt) row.append(button(say("Аварийная остановка", "Emergency stop"), "ghost ag-danger", () => act("agentsKill"), say("Никаких новых сделок, пока стоп не снят", "No new trades until the halt is cleared")));
    if (typeof api.openRing === "function") row.append(h("span", { class: "ag-spacer" }), button(say("Открыть кольцо", "Open the ring"), "ghost", () => api.openRing().catch(() => {})));
    box.append(row);
    if (s.halt) {
      const auto = s.halt.reason !== "manual";
      box.append(h("div", { class: "ag-alert" }, say(`Стоп: ${haltName(s.halt.reason)}${auto ? ` — капитал ${usd(s.halt.equity)} ≤ ${usd(s.halt.limit)}` : ""}. Новых сделок нет, открытые бумажные позиции ведутся до итога.${auto ? " «Снять стоп» примет текущий капитал за новую точку отсчёта." : ""}`,
        `Halt: ${haltName(s.halt.reason)}${auto ? ` — equity ${usd(s.halt.equity)} ≤ ${usd(s.halt.limit)}` : ""}. No new trades; open paper positions are held to resolution.${auto ? " Clear halt takes the current equity as the new reference." : ""}`)));
    }
    if (s.running && !s.active) box.append(h("div", { class: "ag-note" }, say("Агенты включены, но эта сторона сейчас не ведёт исполнение: сделки пойдут, когда она станет активной.", "The agents are on, but this side does not own execution now: trading resumes when it does.")));
    const ai = s.ai || {};
    const v2 = s.v2 || {};
    box.append(h("div", { class: "ag-cards top" },
      card(say("Капитал", "Equity"), usd(s.equity), `${signed(s.pnl)} · ${pct(s.pnlPct)} ${say("от", "from")} ${usd(s.startCapital, 0)}`),
      card(say("Сегодня", "Today"), signed(s.dayPnl), say(`просадка от пика ${pct(s.drawdownPct)}`, `drawdown ${pct(s.drawdownPct)}`), tone(s.dayPnl)),
      card(say("В позициях", "Exposure"), usd(s.exposure), say(`${s.openPositions} поз. · кэш ${usd(s.cash)}`, `${s.openPositions} open · cash ${usd(s.cash)}`)),
      card(say("Сделки", "Trades"), String(s.trades), say(`закрыто ${s.settled} · комиссии ${usd(s.feesPaid)}`, `settled ${s.settled} · fees ${usd(s.feesPaid)}`)),
      card(say("ИИ", "AI"), ai.available ? `${usd(ai.spentUsd, 3)} / ${usd(ai.dailyUsd)}` : say("выкл.", "off"), ai.available ? say(`${ai.calls} запр. сегодня`, `${ai.calls} calls today`) : aiReason(ai.reason)),
      card(say("Рынки", "Markets"), s.universe && s.universe.events ? `${s.universe.events} / ${s.universe.markets}` : "—",
        s.lastTickAt ? say(`цикл ${time(s.lastTickAt)} · ${((s.lastTickMs || 0) / 1000).toFixed(1)} с`, `tick ${time(s.lastTickAt)} · ${((s.lastTickMs || 0) / 1000).toFixed(1)} s`) : say("цикла ещё не было", "no tick yet")),
      s.v2 ? card("V2", signed(v2.pnl), (v2.issues || []).length ? say(`⚠ ${v2.issues.length} пробл. · отдельный счёт`, `⚠ ${v2.issues.length} issue(s) · own account`)
        : say(`сегодня ${signed(v2.dayPnl)} · отдельный счёт`, `today ${signed(v2.dayPnl)} · own account`), tone(v2.pnl)) : null));
    const issues = [];
    if (!ai.available && ["ai_disabled", "ai_key_missing", "ai_agents_openrouter_only"].includes(ai.reason)) {
      issues.push(say("Ключ OpenRouter и общий бюджет ИИ задаются в разделе «ИИ-помощник». Без ИИ работают арбитраж, крипто-уровни, погода и фавориты.",
        "The OpenRouter key and the overall AI budget are set in the AI advisor. Without AI, arbitrage, crypto levels, weather and favourites still work."));
    }
    if (ai.lastError) issues.push(`${say("ИИ", "AI")}: ${ai.lastError}`);
    if (s.lastError) issues.push(`${say("Цикл", "Tick")}: ${s.lastError}`);
    for (const [name, e] of Object.entries(s.sources || {})) issues.push(`${name}: ${e && e.code} · ${time(e && e.at)}`);
    if (issues.length) box.append(h("div", { class: "ag-note" }, issues.map((t) => h("div", null, t))));
    return box;
  }

  function tabsEl() {
    if (!ui.s || ui.s.ok === false || ui.s.error) return h("div");
    return h("div", { class: "ag-tabs", role: "tablist" }, TABS.map(([id, label]) => h("button", { type: "button", class: ui.tab === id ? "on" : "", role: "tab",
      on: { click: () => { if (ui.tab === id) return; ui.tab = id; ui.resetAsk = false; ui.v2Ask = false; if (id === "report") loadReport(); paint(); } } }, pick(label))));
  }

  function rosterEl(s) {
    const rows = (s.agents || []).filter((a) => a.status !== "retired" || a.trades || a.open);
    if (!rows.length) return empty(say("Состав пуст.", "No agents."));
    return h("div", { class: "ag-list" }, rows.map((a) => h("div", { class: `ag-agent ${a.status}` },
      h("div", { class: "ag-agent-head" }, h("span", { class: "ag-id" }, a.id), h("strong", null, TYPES[a.type] ? typeName(a.type) : a.label || typeName(a.type)),
        h("span", { class: `ag-chip ${a.status === "active" ? "pos" : ""}` }, STATUS[a.status] ? pick(STATUS[a.status]) : a.status),
        a.v2 ? h("span", { class: "ag-chip v2", title: say("Отдельный бумажный счёт V2: не влияет на капитал стола", "The V2 paper account: apart from the desk's equity") }, `V2 · ${usd(a.capital, 0)}`) : null,
        a.note && a.note !== "manual" ? h("span", { class: "ag-muted" }, noteText(a.note)) : null, h("span", { class: "ag-spacer" }),
        a.status === "active" ? button(say("Пауза", "Pause"), "ghost sm", () => act("agentsAgent", { id: a.id, action: "pause" }))
          : a.status === "paused" ? button(say("Вернуть", "Resume"), "ghost sm", () => act("agentsAgent", { id: a.id, action: "resume" })) : null),
      a.about ? h("div", { class: "ag-about" }, a.about) : null,
      h("div", { class: "ag-stats" }, stat("P&L", signed(a.pnl), tone(a.pnl)), stat(say("сделок", "trades"), a.trades),
        stat(say("закрыто", "settled"), `${a.settled} (${a.wins} ✓)`), stat(say("открыто", "open"), `${a.open} · ${usd(a.exposure)}`),
        a.brier != null ? stat("Brier", `${a.brier.toFixed(3)} · ${say("рынок", "market")} ${a.marketBrier != null ? a.marketBrier.toFixed(3) : "—"}`) : null,
        a.lane ? stat(say("за сутки", "today"), signed(a.lane.dayPnl), tone(a.lane.dayPnl)) : null,
        a.lane ? stat(say("полоса", "lane"), a.lane.error ? reason(a.lane.error) : a.lane.dayStopped ? say("дневной лимит", "daily limit")
          : a.lane.running ? say("работает", "running") : say("ждёт старта стола", "waits for the desk")) : null))));
  }

  function positionsEl(s) {
    const rows = s.positions || [];
    if (!rows.length) return empty(say("Открытых позиций нет.", "No open positions."));
    return table([say("Событие · исход", "Event · outcome"), say("Агент", "Agent"), say("Доли", "Shares"), say("Вход → сейчас", "Entry → mark"), say("Стоимость", "Value"), "P&L"],
      rows.map((p) => [
        h("div", null, h("div", { class: "ag-strong" }, p.eventTitle || p.eventSlug), h("div", { class: "ag-muted" }, `${p.outcome} · ${p.label}${p.endDate ? ` · ${say("итог", "ends")} ${stamp(p.endDate)}` : ""}`)),
        `${p.agentId} ${typeName(p.type)}`, shares(p.shares), `${cents(p.entry)} → ${cents(p.mark)}`, usd(p.value), h("span", { class: tone(p.pnl) }, signed(p.pnl)),
      ]));
  }

  function candidatesEl(s) {
    const rows = s.candidates || [];
    if (!rows.length) return empty(s.running ? say("В этом цикле кандидатов нет.", "No candidates in this tick.") : say("Кандидаты появляются, когда агенты работают.", "Candidates show up while the agents run."));
    return table([say("Рынок", "Market"), say("Агент", "Agent"), say("Сторона", "Side"), say("Перевес", "Edge"), say("Решение", "Decision")],
      rows.map((c) => [
        h("div", null, h("div", { class: "ag-strong" }, c.label || c.title), c.title && c.title !== c.label ? h("div", { class: "ag-muted" }, c.title) : null),
        `${c.agentId || ""} ${typeName(c.type)}`, c.side ? c.side.toUpperCase() : "—", c.edge != null ? pct(c.edge) : "—",
        h("div", null, h("span", { class: `ag-chip ${c.verdict === "traded" ? "pos" : ""}` }, VERDICT[c.verdict] ? pick(VERDICT[c.verdict]) : c.verdict), c.why ? h("div", { class: "ag-muted" }, c.why) : null),
      ]));
  }

  function journalEl(s) {
    const rows = s.journal || [];
    if (!rows.length) return empty(say("Журнал пуст.", "The journal is empty."));
    return h("div", { class: "ag-log" }, rows.map((r) => h("div", { class: ["ag-log-row", r.kind, r.state, r.op].filter((x) => typeof x === "string" && /^[a-z0-9_]+$/.test(x)).join(" ") },
      h("span", { class: "ag-time" }, stamp(r.t)), h("span", null, journalText(r)))));
  }

  function reportEl() {
    const seg = h("div", { class: "ag-tabs ag-period" }, [["day", "Сутки", "Day"], ["week", "Неделя", "Week"], ["all", "Всё время", "All time"]].map(([p, ru, en]) =>
      h("button", { type: "button", class: ui.period === p ? "on" : "", on: { click: () => { if (ui.period !== p) { ui.period = p; loadReport(); } } } }, say(ru, en))));
    const r = ui.report;
    if (!r) return h("div", null, seg, empty(say("Загрузка…", "Loading…")));
    if (r.ok === false) return h("div", null, seg, empty(reason(r.reason)));
    const t = r.totals || {};
    const agents = (r.agents || []).filter((a) => a.trades || a.settled || a.open);
    return h("div", null, seg,
      h("div", { class: "ag-cards" },
        card(say("Реализовано", "Realized"), signed(t.realized), say(`всего с начала ${signed(r.pnl)}`, `${signed(r.pnl)} since the start`), tone(t.realized)),
        card(say("Сделки", "Trades"), String(t.trades || 0), say(`закрыто ${t.settled || 0}, в плюс ${t.wins || 0}`, `settled ${t.settled || 0}, ${t.wins || 0} won`)),
        card(say("Комиссии", "Fees"), usd(t.fees)), card(say("ИИ", "AI"), usd(r.ai && r.ai.spentUsd, 3), say(`${(r.ai && r.ai.calls) || 0} запр.`, `${(r.ai && r.ai.calls) || 0} calls`))),
      agents.length ? table([say("Агент", "Agent"), say("Сделок", "Trades"), say("Закрыто", "Settled"), say("В плюс", "Won"), say("Итог", "Realized"), "Brier"],
        agents.map((a) => [`${a.id} ${typeName(a.type)}`, a.trades, a.settled, a.wins, h("span", { class: tone(a.realized) }, signed(a.realized)),
          a.brier != null ? `${a.brier.toFixed(3)} / ${a.marketBrier != null ? a.marketBrier.toFixed(3) : "—"}` : "—"])) : empty(say("За период сделок нет.", "No trades in the period.")),
      v2ReportEl(r.v2),
      (r.closed || []).length ? h("div", null, h("h3", { class: "ag-h3" }, say("Закрытые позиции", "Closed positions")),
        table([say("Когда", "When"), say("Агент", "Agent"), say("Исход", "Outcome"), say("Вложено", "Cost"), say("Итог", "Result")],
          r.closed.map((p) => [stamp(p.closedAt), `${p.agentId} ${typeName(p.type)}`, `${p.outcome} «${p.label}»`, usd(p.cost), h("span", { class: tone(p.pnl) }, signed(p.pnl))]))) : null);
  }

  function v2ReportEl(v) {
    const rows = v && Array.isArray(v.rows) ? v.rows.filter((x) => x.status !== "retired" || x.trades) : [];
    if (!rows.length) return null;
    return h("div", null, h("h3", { class: "ag-h3" }, say(`V2 · отдельный счёт: всего ${signed(v.pnl)}`, `V2 · its own account: ${signed(v.pnl)} overall`)),
      table([say("Полоса", "Lane"), say("Сделок", "Trades"), say("Закрыто", "Settled"), say("В плюс", "Won"), say("Итог", "Realized"), say("Сертификат", "Certificate")],
        rows.map((x) => [`${x.id} ${typeName(x.type)}`, x.trades, x.type === "lp_rewards" ? "—" : x.settled, x.type === "lp_rewards" ? "—" : x.wins,
          h("span", { class: tone(x.realized) }, signed(x.realized)), verdictChip((v[x.type] || {}).verdict)])));
  }

  // The V2 tab: what runs, the watchdog, a9's certificate (latarb_v2) and a10's (lp_v1), a fresh start and the files.
  const LAT_CHECKS = {
    btc_trades: ["Сделок BTC (5m и 15m)", "BTC trades (5m and 15m)"], primary_trades: ["Сделок BTC 5m", "BTC 5m trades"],
    exit: ["Выход через 10 с, на акцию", "Exit after 10 s, per share"], resolution: ["Если держать до итога, на акцию", "Held to the result, per share"],
    day_share: ["Доля лучшего дня в прибыли", "The best day's share of the profit"], positive_days: ["Полных дней в плюс", "Full days in profit"],
  };
  const ROLES = { primary: ["основная", "primary"], secondary: ["вторая · тень", "secondary · shadow"], control: ["контроль · тень", "control · shadow"] };
  const LP_CHECKS = { hours: ["Часов с живыми данными", "Hours with live data"], net: ["Итог > 0", "Net > 0"], top_market: ["Крупнейший рынок ≤ 25% итога", "Top market ≤ 25% of the net"] };
  const mark = (ok, final) => h("span", { class: ok ? "pos" : final ? "neg" : "ag-muted" }, ok ? "✓" : final ? "×" : "…");

  function latCheck(x, final) {
    const name = LAT_CHECKS[x.id] ? pick(LAT_CHECKS[x.id]) : x.id;
    let value = "—", need = "";
    if (x.id === "btc_trades" || x.id === "primary_trades") { value = count(x.value); need = `≥ ${count(x.need)}`; }
    else if (x.id === "exit") { value = `${perShare(x.value)}${finite(x.t) ? ` · t ${fixed(x.t)} · p ${pv(x.p)}` : ""}`; need = "> 0, p < 0.01"; }
    else if (x.id === "resolution") { value = perShare(x.value); need = "> 0"; }
    else if (x.id === "day_share") { value = finite(x.value) ? pct(x.value, 0) : "—"; need = "≤ 50%"; }
    else if (x.id === "positive_days") { value = `${x.positive || 0} / ${x.full || 0}${finite(x.value) ? ` · ${pct(x.value, 0)}` : ""}`; need = say(`≥ 70%, от ${x.minFull || 3} полных дней`, `≥ 70%, ${x.minFull || 3}+ full days`); }
    return [name, value, need, mark(x.ok, final)];
  }

  function laneHead(id, type, b, rule, extra) {
    return h("div", { class: "ag-agent-head" }, h("span", { class: "ag-id" }, id || "—"), h("strong", null, typeName(type)), h("span", { class: "ag-muted" }, rule),
      verdictChip(b.verdict), b.status && b.status !== "active" ? h("span", { class: "ag-chip" }, STATUS[b.status] ? pick(STATUS[b.status]) : b.status) : null,
      h("span", { class: "ag-spacer" }), extra || null);
  }

  function latEl(b, lane) {
    const c = b.cert || {}, final = Boolean(c.final || c.kill), feeds = (lane && lane.feeds) || {};
    const box = h("div", { class: "ag-agent ag-v2" }, laneHead(b.agentId, "latency", b, "latarb_v2"));
    box.append(h("div", { class: "ag-stats" }, stat("P&L", signed(b.pnl), tone(b.pnl)), stat(say("сегодня", "today"), signed(b.dayPnl), tone(b.dayPnl)),
      stat(say("сделок", "trades"), b.trades), stat(say("комиссии", "fees"), usd(b.fees)), stat(say("капитал", "capital"), `${usd(b.capitalUsd, 0)} · ${say("до $100 на сделку", "up to $100 a trade")}`),
      stat(say("полоса", "lane"), b.error ? reason(b.error) : b.running ? say("работает", "running") : say("ждёт старта", "waiting to start")),
      b.running ? stat("Binance / CLOB", `${time(feeds.binance)} / ${time(feeds.clob)}`) : null,
      b.running ? stat(say("окон", "windows"), feeds.windows ?? 0) : null));
    if (c.kill) box.append(h("div", { class: "ag-alert" }, say(`Сработало правило остановки (${stamp(c.kill.t)}): после ${count(c.kill.trades)} сделок BTC 5m выход ${perShare(c.kill.exit)} на акцию ≤ 0. Агент на паузе, тест V2 не пройден; по протоколу — остановиться и разобраться.`,
      `The kill switch fired (${stamp(c.kill.t)}): after ${count(c.kill.trades)} BTC 5m trades the exit is ${perShare(c.kill.exit)} a share ≤ 0. The agent is paused and the V2 test failed; the protocol says stop and re-examine.`)));
    else if (c.final) box.append(h("div", { class: c.final.verdict === "pass" ? "ag-note ag-good" : "ag-alert" }, say(`Вердикт вынесен ${stamp(c.final.t)}: ${pick(verdictOf(c.final.verdict))}. Он один и больше не пересчитывается; данные продолжают копиться для справки.`,
      `The verdict was taken ${stamp(c.final.t)}: ${pick(verdictOf(c.final.verdict))}. It is taken once; the data keep accumulating for the record.`)));
    for (const w of c.warnings || []) {
      if (w.id === "control_positive") box.append(h("div", { class: "ag-note" }, say(`Контроль ${w.key} в плюсе (t ${fixed(w.t)}): прибыль может быть общим движением рынка, а не задержкой. Разберитесь до решения.`,
        `The control ${w.key} is in profit (t ${fixed(w.t)}): the profit may be a market-wide move rather than latency. Look into it before deciding.`)));
    }
    if (Array.isArray(c.checks)) box.append(table([say("Проверка", "Check"), say("Сейчас", "Now"), say("Нужно", "Needed"), ""], c.checks.map((x) => latCheck(x, final))));
    const groups = c.groups || [];
    if (groups.length) {
      box.append(h("h3", { class: "ag-h3" }, say("По группам (сумма по окну — одно наблюдение)", "By group (one observation per window)")),
        table([say("Группа", "Group"), say("Роль", "Role"), say("Сделок", "Trades"), say("Окон", "Windows"), say("Выход/акц.", "Exit/share"), "t", "p", say("До итога/акц.", "To result/share"), say("Ждут итога", "Awaiting result")],
          groups.map((g) => [g.key, ROLES[g.role] ? pick(ROLES[g.role]) : g.role, count(g.trades), count(g.windows), h("span", { class: tone(g.exit) }, perShare(g.exit)), fixed(g.t), pv(g.p),
            h("span", { class: tone(g.res) }, perShare(g.res)), `${g.pending || 0}${g.noResult ? say(` · без итога ${g.noResult}`, ` · none ${g.noResult}`) : ""}`])));
    }
    const days = c.days || [];
    if (days.length) {
      box.append(h("h3", { class: "ag-h3" }, say("По дням UTC (основная группа)", "By UTC day (traded windows)")),
        table([say("День", "Day"), say("Сделок", "Trades"), "P&L", say("Часов с данными", "Hours live"), say("Полный", "Full")],
          days.map((d) => [d.day, count(d.trades), h("span", { class: tone(d.pnl) }, signed(d.pnl)), fixed(d.upH, 1), d.full ? "✓" : ""])));
    }
    box.append(h("div", { class: "ag-muted ag-foot" }, say(`Полный день — не меньше 20 ч с живыми данными Binance и Polymarket. Вердикт выносится один раз, когда набраны сделки и есть 3 полных дня. Тени (BTC 15m, ETH) торгуют тем же правилом только для сертификата. Ждут итога: ${c.pending || 0} окон.`,
      `A full day has at least 20 h of live Binance and Polymarket data. The verdict is taken once, when the trades are in and there are 3 full days. The shadows (BTC 15m, ETH) trade the same rule for the certificate only. Windows waiting for a result: ${c.pending || 0}.`)));
    return box;
  }

  function lpEl(b, lane) {
    const c = b.cert || {}, l = lane || {};
    const box = h("div", { class: "ag-agent ag-v2" }, laneHead(b.agentId, "lp_rewards", b, "lp_v1"));
    box.append(h("div", { class: "ag-stats" }, stat("P&L", signed(b.pnl), tone(b.pnl)), stat(say("сегодня", "today"), signed(b.dayPnl), tone(b.dayPnl)),
      stat(say("заполнений", "fills"), b.trades), stat(say("капитал", "capital"), `${usd(b.capitalUsd, 0)} · ${say("до $200 на рынок", "up to $200 a market")}`),
      stat(say("полоса", "lane"), b.error ? reason(b.error) : b.running ? say("работает", "running") : say("ждёт старта", "waiting to start")),
      b.running ? stat(say("рынков", "markets"), `${l.quoting ?? 0} / ${l.markets ?? 0}${l.pulled ? say(` · снято ${l.pulled}`, ` · pulled ${l.pulled}`) : ""}`) : null,
      b.running ? stat(say("стаканы / сделки", "books / trades"), `${time(l.lastPollAt)} / ${time(l.rtds && l.rtds.lastAt)}`) : null,
      l.shadow ? stat(say("без щита", "without the shield"), signed(l.shadow.pnl), tone(l.shadow.pnl)) : null));
    const phase = (n, p) => p ? [say(`Фаза ${n}`, `Phase ${n}`), `${fixed(p.hours, 1)} / 24`, p.markets, h("span", { class: tone(p.net) }, signed(p.net)),
      h("span", { class: tone(p.netH) }, signed(p.netH)), finite(p.topShare) ? pct(p.topShare, 0) : "—",
      h("span", null, (p.checks || []).map((x) => h("span", { class: "ag-check-mark", title: LP_CHECKS[x.id] ? pick(LP_CHECKS[x.id]) : x.id }, mark(x.ok, p.done))))] : null;
    const rows = [phase(1, c.phase1), phase(2, c.phase2)].filter(Boolean);
    if (rows.length) box.append(table([say("Фаза", "Phase"), say("Часов", "Hours"), say("Рынков", "Markets"), say("Итог (со щитом)", "Net (shield)"), say("Без щита", "No shield"), say("Крупнейший рынок", "Top market"), say("Проверки", "Checks")], rows));
    const sh = c.shield || {};
    const shieldText = !sh.decided ? say(`t ${fixed(sh.t)} — решится по итогам фазы 1 (нужно t > 2 при итоге > 0)`, `t ${fixed(sh.t)} — decided on phase 1 (needs t > 2 with a net > 0)`)
      : sh.helps ? say(`помогает: t ${fixed(sh.t)} > 2`, `helps: t ${fixed(sh.t)} > 2`) : say(`пользы не доказал: t ${fixed(sh.t)}`, `did not prove itself: t ${fixed(sh.t)}`);
    box.append(h("div", { class: "ag-stats" }, stat(say("часов V2", "V2 hours"), fixed(c.upH, 1)), stat(say("щит", "shield"), shieldText),
      c.perDay ? stat(say("в сутки", "a day"), `${signed(c.perDay.net)} · ${say("шоков", "shocks")} ${fixed(c.perDay.shocks, 1)}`) : null,
      finite(c.pulledShare) ? stat(say("снято щитом", "pulled by the shield"), pct(c.pulledShare)) : null,
      finite(c.rewardsGivenUp) ? stat(say("награды, отданные щитом", "rewards given up to the shield"), usd(c.rewardsGivenUp)) : null));
    box.append(h("div", { class: "ag-muted ag-foot" }, say("Фаза — 24 ч, пока приходят и стаканы, и лента сделок. Пройдено: итог > 0 и ни один рынок не больше 25% итога — в обеих фазах; перед фазой 2 набор рынков собирается заново. «Без щита» — тень с теми же заявками, но без новостного щита.",
      "A phase is 24 h with both the books and the trade feed live. A pass: a net > 0 with no market above 25% of it, in both phases; the markets are rebuilt before phase 2. No shield is a shadow with the same quotes but without the news shield.")));
    return box;
  }

  function v2El(s) {
    const v = s.v2 || {}, lanes = s.lanes || {}, box = h("div", { class: "ag-v2-tab" });
    // an older desk (a server not yet updated) has no V2 account: nothing to show or reset here
    if (!v.latency && !v.lp_rewards) return empty(say("Полос V2 нет на этой стороне: обновите Vespera там, где идёт исполнение.", "No V2 lanes on this side: update Vespera where execution runs."));
    box.append(h("div", { class: "ag-note" }, say("V2 — отдельный бумажный счёт для двух быстрых полос по предрегистрации: a9 (latarb_v2) и a10 (lp_v1), в масштабе протоколов. Их результат не входит в капитал стола и не включает его стопы. Полосы работают, пока агенты запущены; «Стоп» и аварийная остановка останавливают и их, автоматический стоп стола — нет.",
      "V2 is a separate paper account for the two fast lanes under their preregistrations, a9 (latarb_v2) and a10 (lp_v1), at the protocols' scale. Their results stay out of the desk's equity and its halts. The lanes run while the agents run; Stop and the emergency stop stop them too, the desk's automatic halts do not.")));
    const issues = v.issues || [];
    if (issues.length) {
      box.append(h("div", { class: "ag-alert" }, issues.map((i) => h("div", null, `${i.agentId} ${typeName(i.type)}: ${watchName(i.code)}${i.error ? ` (${reason(i.error)})` : ""} · ${say("с", "since")} ${time(i.since)}${i.alerted ? say(" · уведомление отправлено", " · alert sent") : ""}`))));
    } else if (!s.running || (s.halt && s.halt.reason === "manual")) {
      box.append(h("div", { class: "ag-note" }, say("Сейчас полосы V2 не работают: нажмите «Старт», чтобы пошли часы и сделки.", "The V2 lanes are not running now: press Start for the hours and trades to count.")));
    }
    box.append(h("div", { class: "ag-cards" },
      card(say("Счёт V2", "V2 account"), signed(v.pnl), say(`сегодня ${signed(v.dayPnl)}`, `today ${signed(v.dayPnl)}`), tone(v.pnl)),
      card(say("Сделок", "Trades"), count(v.trades), say("a9 сделки + a10 заполнения", "a9 trades + a10 fills")),
      card(say("В позициях", "Exposure"), usd(v.exposure), say("бумага", "paper"))));
    if (v.latency) box.append(latEl(v.latency, lanes.latency));
    if (v.lp_rewards) box.append(lpEl(v.lp_rewards, lanes.lp_rewards));
    const row = h("div", { class: "ag-controls" });
    if (ui.side === "local" && typeof api.openAgentsData === "function") {
      row.append(button(say("Открыть папку данных V2", "Open the V2 data folder"), "ghost", () => {
        api.openAgentsData().then((r) => { if (r && r.ok === false) flash(reason(r.reason), "neg"); }).catch((e) => flash(reason(codeOf(e)), "neg"));
      }, say("Счета, сертификаты и логи сделок полос (JSON/JSONL)", "The lanes' ledgers, certificates and trade logs (JSON/JSONL)")));
    }
    if (row.childNodes.length) box.append(row);
    box.append(v2ResetEl());
    return box;
  }

  function v2ResetEl() {
    const box = h("div", { class: "ag-reset" }, h("div", { class: "ag-strong" }, say("Начать V2 заново", "Start V2 afresh")),
      h("div", { class: "ag-muted" }, say("Новые счёт и сертификаты a9 и a10; стол не затрагивается. Логи сделок остаются в папке данных.", "A new account and certificates for a9 and a10; the desk is untouched. The trade logs stay in the data folder.")));
    if (!ui.v2Ask) box.append(h("div", { class: "btn-row" }, button(say("Начать V2 заново…", "Start V2 afresh…"), "ghost ag-danger", () => { ui.v2Ask = true; paint(); })));
    else {
      box.append(h("div", { class: "ag-confirm" }, say("Сбросить счёт и сертификаты V2? Набранные сделки, часы и вердикты перестанут учитываться.", "Reset the V2 account and certificates? The trades, hours and verdicts so far stop counting."),
        h("div", { class: "btn-row" }, button(say("Да, начать V2 заново", "Yes, start V2 afresh"), "ok ag-danger-ok", () => { ui.v2Ask = false; act("agentsReset", { scope: "v2", confirm: true }, say("V2 начат заново.", "V2 started afresh.")); }),
          button(say("Отмена", "Cancel"), "ghost", () => { ui.v2Ask = false; paint(); }))));
    }
    return box;
  }

  function settingsEl(s) {
    const cfg = s.config || {}, lim = s.limits || {};
    const grid = h("div", { class: "ag-grid" });
    for (const [key, ru, en] of FIELDS) {
      const l = lim[key] || [];
      grid.append(h("label", { class: "field" }, h("span", { class: "field-label" }, say(ru, en)),
        h("input", { type: "number", "data-key": key, value: cfg[key] == null ? "" : String(cfg[key]), min: l[0], max: l[1], step: l[2] ? 1 : "any" })));
    }
    const toggles = h("div", { class: "ag-toggles" }, TOGGLES.map(([key, ru, en]) => h("label", { class: "ag-check" },
      h("input", { type: "checkbox", "data-key": key, checked: Boolean(cfg[key]) }), say(ru, en))));
    return h("div", { class: "ag-settings" },
      h("div", { class: "ag-note" }, say("Только бумага: режим реальных денег недоступен до сертификата (M6). Капитал меняется через «Начать заново», если сделки уже были.",
        "Paper only: real money is unavailable until the certificate (M6). Capital changes with Start afresh once there are trades.")),
      grid, toggles, h("div", { class: "btn-row" }, button(say("Сохранить", "Save"), "ok", save)), resetEl());
  }

  function resetEl() {
    const s = ui.s || {};
    const box = h("div", { class: "ag-reset" }, h("div", { class: "ag-strong" }, say("Начать заново", "Start afresh")),
      h("div", { class: "ag-muted" }, say("Новый бумажный счёт и стартовый состав агентов. Журнал сохраняется. Счёт V2 (a9, a10) не затрагивается — у него своя кнопка во вкладке V2.",
        "A new paper book and the starting roster. The journal is kept. The V2 account (a9, a10) is untouched: it has its own button in the V2 tab.")));
    if (!ui.resetAsk) {
      const capital = h("input", { type: "number", value: String((s.config && s.config.capitalUsd) || ui.resetCapital || 1000), min: 10, max: 10000000, step: "any" });
      box.append(h("div", { class: "ag-reset-row" }, h("label", { class: "field" }, h("span", { class: "field-label" }, say("Капитал, $", "Capital, $")), capital),
        button(say("Начать заново…", "Start afresh…"), "ghost ag-danger", () => {
          const v = Number(capital.value);
          if (!capital.value.trim() || !Number.isFinite(v) || v < 10 || v > 10000000) return flash(reason("agents_config_invalid"), "neg");
          ui.resetCapital = v; ui.resetAsk = true; paint();
        })));
    } else {
      box.append(h("div", { class: "ag-confirm" }, say(`Сбросить бумажный счёт и начать с ${usd(ui.resetCapital, 0)}? Открытые бумажные позиции будут забыты.`,
        `Reset the paper book and start with ${usd(ui.resetCapital, 0)}? Open paper positions are dropped.`),
      h("div", { class: "btn-row" }, button(say("Да, начать заново", "Yes, start afresh"), "ok ag-danger-ok", () => { ui.resetAsk = false; act("agentsReset", { capitalUsd: ui.resetCapital, confirm: true }, say("Начато заново.", "Started afresh.")); }),
        button(say("Отмена", "Cancel"), "ghost", () => { ui.resetAsk = false; paint(); }))));
    }
    return box;
  }

  function contentEl() {
    const s = ui.s;
    if (!s || s.ok === false || s.error) return h("div");
    const by = { agents: rosterEl, v2: v2El, positions: positionsEl, candidates: candidatesEl, journal: journalEl, report: reportEl, settings: settingsEl }[ui.tab] || rosterEl;
    return h("div", { class: "ag-content" }, by(s));
  }

  // ---- painting ---------------------------------------------------------------------------------------------------
  function paint(fromPoll = false) {
    if (!ui.open || !panel) return;
    // a poll never wipes a settings form being edited
    const keep = Boolean(fromPoll && els && ui.tab === "settings" && els.content.isConnected && els.content.querySelector(".ag-settings"));
    const scroll = els ? els.body.scrollTop : 0;
    const next = { head: headEl(), top: topEl(), tabs: tabsEl(), content: keep ? els.content : contentEl() };
    next.body = h("div", { class: "ag-body" }, next.top, next.tabs, next.content);
    panel.replaceChildren(next.head, next.body);
    next.body.scrollTop = scroll;
    els = next;
  }

  function flash(text, toneName = "") {
    clearTimeout(ui.msgTimer);
    ui.msg = text ? { text, tone: toneName } : null;
    if (text) ui.msgTimer = setTimeout(() => { ui.msg = null; if (ui.open) paint(true); }, 6000);
    paint(true);
  }

  async function refresh() {
    const seq = ++ui.seq;
    let s;
    try { s = await api.agentsStatus(); } catch (error) { s = { ok: false, reason: codeOf(error) }; }
    if (seq !== ui.seq || !ui.open) return;
    ui.s = s;
    if (s && s.config && !ui.resetAsk) ui.resetCapital = s.config.capitalUsd;
    paint(true);
  }

  async function loadReport() {
    const seq = ++ui.rseq;
    ui.report = null;
    paint();
    let r;
    try { r = await api.agentsReport({ period: ui.period }); } catch (error) { r = { ok: false, reason: codeOf(error) }; }
    if (seq !== ui.rseq) return;
    ui.report = r;
    if (ui.open && ui.tab === "report") paint();
  }

  async function act(method, arg, okText) {
    if (ui.busy || typeof api[method] !== "function") return;
    ui.busy = true;
    paint(true);
    let res;
    try { res = await api[method](arg); } catch (error) { res = { ok: false, reason: codeOf(error) }; }
    ui.busy = false;
    ui.seq += 1;   // a poll that started before the action must not paint over its result
    if (res && res.ok === false) flash(reason(res.reason), "neg");
    else {
      if (res && res.ok === true && res.config) ui.s = res;
      flash(okText || null);
      if (method === "agentsConfigure" || method === "agentsReset") paint();
      if (ui.tab === "report") loadReport();
    }
    refresh();
  }

  async function save() {
    const s = ui.s;
    if (!s || !s.config || !panel) return;
    const patch = {};
    for (const input of panel.querySelectorAll(".ag-settings input[data-key]")) {
      const key = input.dataset.key;
      if (input.type === "checkbox") { if (input.checked !== Boolean(s.config[key])) patch[key] = input.checked; continue; }
      const value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value)) return flash(reason("agents_config_invalid"), "neg");
      if (value !== s.config[key]) patch[key] = value;
    }
    if (!Object.keys(patch).length) return flash(say("Без изменений.", "Nothing changed."));
    await act("agentsConfigure", patch, say("Сохранено.", "Saved."));
  }

  // ---- open / close -----------------------------------------------------------------------------------------------
  function open() {
    const appPanel = document.getElementById("panel");
    if (appPanel && !appPanel.hidden) { const x = document.getElementById("panelClose"); if (x) x.click(); }
    document.querySelectorAll(".rail-item").forEach((b) => b.classList.toggle("on", b === rail));
    Object.assign(ui, { open: true, msg: null, resetAsk: false, v2Ask: false, report: null });
    shade.hidden = false;
    panel.hidden = false;
    paint();
    refresh();
    if (ui.tab === "report") loadReport();
    clearInterval(ui.timer);
    ui.timer = setInterval(refresh, POLL_MS);
    if (typeof api.getExecution === "function") api.getExecution().then((x) => { ui.side = x && x.mode; if (ui.open) paint(true); }).catch(() => {});
  }

  function close(restore = true) {
    if (!ui.open) return;
    ui.open = false;
    ui.seq += 1;
    ui.rseq += 1;
    clearInterval(ui.timer);
    ui.timer = 0;
    shade.hidden = true;
    panel.hidden = true;
    panel.replaceChildren();
    els = null;
    rail.classList.remove("on");
    if (restore && !document.querySelector(".rail-item.on")) {
      const home = document.querySelector('.rail-item[data-panel="chart"]');
      if (home) home.classList.add("on");
    }
  }

  function label() { if (railText) railText.textContent = say("Агенты", "Agents"); }

  function mount() {
    const railEl = document.getElementById("rail");
    if (!railEl || rail) return;
    railText = h("span", null, "");
    rail = h("button", { class: "rail-item", type: "button", "data-panel": "agents" }, h("span", { class: "ico" }, "◈"), railText);
    const after = railEl.querySelector('.rail-item[data-panel="ai"]');
    if (after) after.after(rail); else railEl.prepend(rail);
    // ours before app.js sees it: the app's own rail handler never runs for this button
    railEl.addEventListener("click", (e) => {
      const item = e.target && e.target.closest ? e.target.closest(".rail-item") : null;
      if (!item) return;
      if (item === rail) { e.stopImmediatePropagation(); e.preventDefault(); if (ui.open) close(); else open(); }
      else if (ui.open) close(false);
    }, true);
    shade = h("div", { class: "ag-shade", hidden: true, on: { click: () => close() } });
    panel = h("section", { class: "ag-panel glass", hidden: true, role: "dialog", "aria-modal": "true" });
    document.body.append(shade, panel);
    document.addEventListener("keydown", (e) => { if (ui.open && e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } }, true);
    new MutationObserver(() => { label(); if (ui.open) paint(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    label();
    if (typeof api.onEvent === "function") {
      let soon = 0;
      api.onEvent((evt) => {
        if (!ui.open || !evt || (evt.type !== "agents" && evt.type !== "agents_alert")) return;
        clearTimeout(soon);
        soon = setTimeout(refresh, 300);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
