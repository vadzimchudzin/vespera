"use strict";

// Texts of the agents desk for Telegram: status, the trade digest, roster changes, halt alerts and the daily report,
// in Russian or English. Plain text built from the desk's own numbers; everything here is paper. The V2 lanes (a9, a10)
// keep their own paper account and certificates: their lines, alerts and the watchdog's come last.

const { TYPES } = require("./roster");

const say = (locale, ru, en) => (locale === "ru" ? ru : en);
const grouped = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const usd = (x) => { const v = Number(x) || 0; return `${v < 0 ? "−" : ""}$${grouped(Math.abs(v).toFixed(2))}`; };
const signed = (x) => { const v = Number(x) || 0; return `${v > 0.004 ? "+" : v < -0.004 ? "−" : ""}$${grouped(Math.abs(v).toFixed(2))}`; };
const pct = (x, d = 1) => `${((Number(x) || 0) * 100).toFixed(d)}%`;
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const typeName = (type, locale) => (TYPES[type] ? TYPES[type][locale === "ru" ? "ru" : "en"] : String(type || "?"));

const HALTS = {
  manual: ["ручная остановка", "manual stop"],
  daily_loss: ["дневной убыток", "daily loss"],
  drawdown: ["просадка от пика", "drawdown from the peak"],
};
const REASONS = {
  loss_30: ["убыток 30% капитала агента", "a loss of 30% of the agent's capital"],
  loss_10_after_20: ["убыток 10% после 20 сделок", "a loss of 10% after 20 trades"],
  brier_worse_than_market: ["прогнозы хуже рынка (Brier)", "forecasts worse than the market (Brier)"],
  retest_after_72h: ["повторная проверка через 72 ч", "retest after 72 h"],
  ai_plan: ["по плану ИИ", "on the AI's plan"],
  manual: ["вручную", "by hand"],
  replaced_by_lp: ["заменён агентом «LP с наградами»", "replaced by LP with rewards"],
  v2_kill_switch: ["правило остановки V2 (выход ≤ 0 после 500 сделок)", "the V2 kill switch (an exit ≤ 0 after 500 trades)"],
};
const reasonText = (reason, locale) => {
  if (REASONS[reason]) return say(locale, ...REASONS[reason]);
  const variant = /^variant_of_(a\d+)$/.exec(reason || "");
  if (variant) return say(locale, `вариант ${variant[1]}, который зарабатывает`, `a variant of ${variant[1]}, which earns`);
  return String(reason || "");
};
const haltName = (reason, locale) => (HALTS[reason] ? say(locale, ...HALTS[reason]) : String(reason || "?"));

// --- V2 -----------------------------------------------------------------------------------------------------------
const VERDICTS = {
  collecting: ["идёт сбор", "collecting"],
  pass: ["пройден ✓", "passed ✓"],
  fail: ["не пройден ✗", "failed ✗"],
  kill: ["остановлен правилом ✗", "stopped by the kill switch ✗"],
};
const verdictName = (v, locale) => say(locale, ...(VERDICTS[v] || VERDICTS.collecting));
const WATCH = {
  down: ["не работает", "is down"],
  binance: ["нет данных Binance", "no data from Binance"],
  clob: ["нет стаканов Polymarket", "no Polymarket order books"],
  books: ["не приходят стаканы", "no order books"],
  rtds: ["нет ленты сделок Polymarket", "no Polymarket trade feed"],
};
const watchName = (code, locale) => (WATCH[code] ? say(locale, ...WATCH[code]) : String(code || "?"));
// the network's codes in words; anything else stays a code
const NET = {
  agents_source_unavailable: ["нет связи с Polymarket", "no connection to Polymarket"],
  agents_timeout: ["Polymarket не ответил вовремя", "Polymarket did not answer in time"],
  agents_proxy_invalid: ["прокси указан, но не работает — проверьте адрес в панели API", "the proxy is set but unusable — check the address in the API panel"],
  agents_proxy_down: ["прокси не отвечает", "the proxy does not answer"],
  agents_proxy_auth: ["прокси отклонил логин или пароль", "the proxy rejected the login or password"],
  agents_proxy_timeout: ["прокси не ответил вовремя", "the proxy timed out"],
  agents_proxy_dropped: ["прокси оборвал соединение", "the proxy dropped the connection"],
  agents_proxy_host: ["адрес прокси не найден", "the proxy's host was not found"],
  agents_proxy_target_refused: ["прокси не открыл соединение с Polymarket", "the proxy would not open the connection to Polymarket"],
};
const netName = (code, locale) => (NET[code] ? say(locale, ...NET[code]) : String(code));
const cents = (x) => (x == null || !Number.isFinite(+x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(2)}¢`);
const count = (x) => grouped(String(Math.round(Number(x) || 0)));
const pval = (p) => (p == null ? "—" : p < 0.001 ? "< 0.001" : Number(p).toFixed(3));

// Where a lane's certificate stands: a9's counts, exit and full days; a10's phase, hours and net.
function certText(type, b, locale) {
  const c = b && b.cert;
  if (!c) return verdictName(b && b.verdict, locale);
  const parts = [];
  if (type === "latency") {
    const ch = (id) => (c.checks || []).find((x) => x.id === id) || {};
    const pr = ch("primary_trades"), btc = ch("btc_trades"), ex = ch("exit"), pd = ch("positive_days");
    parts.push(say(locale, `BTC 5m ${count(pr.value)}/${count(pr.need)} сд. (BTC всего ${count(btc.value)}/${count(btc.need)})`,
      `BTC 5m ${count(pr.value)}/${count(pr.need)} trades (all BTC ${count(btc.value)}/${count(btc.need)})`));
    if (ex.value != null) parts.push(say(locale, `выход ${cents(ex.value)}/акц.${ex.p != null ? ` (p ${pval(ex.p)})` : ""}`, `exit ${cents(ex.value)}/share${ex.p != null ? ` (p ${pval(ex.p)})` : ""}`));
    parts.push(say(locale, `полных дней ${c.fullDays || 0}/${pd.minFull || 3}`, `full days ${c.fullDays || 0}/${pd.minFull || 3}`));
  } else {
    const ph = c.phase === 1 ? c.phase1 : c.phase === 2 ? c.phase2 : null;
    if (ph) parts.push(say(locale, `фаза ${c.phase}: ${(Number(ph.hours) || 0).toFixed(1)}/24 ч, итог ${signed(ph.net)}`, `phase ${c.phase}: ${(Number(ph.hours) || 0).toFixed(1)}/24 h, net ${signed(ph.net)}`));
    else parts.push(say(locale, "обе фазы закрыты", "both phases closed"));
    if (c.shield && c.shield.t != null) parts.push(say(locale, `щит t ${c.shield.t}`, `shield t ${c.shield.t}`));
  }
  parts.push(verdictName(b.verdict, locale));
  return parts.join(" · ");
}

// The V2 block of the status: the account, a line per lane, the watchdog's open problems.
function v2Lines(v, locale) {
  const lanes = ["latency", "lp_rewards"].map((type) => [type, v && v[type]]).filter(([, b]) => b && b.agentId && b.status !== "retired");
  if (!lanes.length) return [];
  const lines = [say(locale, `V2 · отдельный бумажный счёт: ${signed(v.pnl)} · сегодня ${signed(v.dayPnl)}`, `V2 · its own paper account: ${signed(v.pnl)} · today ${signed(v.dayPnl)}`)];
  for (const [type, b] of lanes) {
    const mark = b.status === "paused" ? say(locale, " (пауза)", " (paused)") : "";
    lines.push(` ${b.agentId} ${typeName(type, locale)}${mark}: ${signed(b.pnl)} · ${certText(type, b, locale)}`);
  }
  for (const i of (v.issues || []).slice(0, 4)) lines.push(` ⚠ ${i.agentId} ${typeName(i.type, locale)}: ${watchName(i.code, locale)}`);
  return lines;
}

function v2Text(p, locale) {
  const who = `${p.agentId || "?"} ${typeName(p.type, locale)}`;
  if (p.op === "v2_kill") {
    return [say(locale, `V2 · ${who}: сработало правило остановки — после ${count(p.trades)} сделок BTC 5m выход ${cents(p.exit)} на акцию (≤ 0).`,
      `V2 · ${who}: the kill switch fired — after ${count(p.trades)} BTC 5m trades the exit is ${cents(p.exit)} a share (≤ 0).`),
    say(locale, "Агент на паузе, его тест V2 не пройден. По протоколу latarb_v2 — остановиться и разобраться; продолжить можно только вручную.",
      "The agent is paused and its V2 test failed. Per latarb_v2: stop and re-examine; only a manual resume continues it.")].join("\n");
  }
  if (p.op === "v2_verdict") {
    const what = say(locale, `${count(p.trades)} сделок BTC 5m, выход ${cents(p.exit)} на акцию (p ${pval(p.p)})`, `${count(p.trades)} BTC 5m trades, exit ${cents(p.exit)} a share (p ${pval(p.p)})`);
    return p.verdict === "pass"
      ? say(locale, `V2 · ${who}: сертификат пройден ✓ — ${what}. Это бумажный тест; решение о реальных деньгах — за вами.`, `V2 · ${who}: certificate passed ✓ — ${what}. This is a paper test; real money is your call.`)
      : say(locale, `V2 · ${who}: сертификат не пройден ✗ — ${what}. Подробности — во вкладке V2.`, `V2 · ${who}: certificate failed ✗ — ${what}. Details are in the V2 tab.`);
  }
  if (p.op === "v2_phase") {
    const top = p.topShare != null ? pct(p.topShare, 0) : "—";
    const shield = p.phase === 1 && p.shieldT != null ? say(locale, ` · щит t = ${p.shieldT}`, ` · shield t = ${p.shieldT}`) : "";
    const head = say(locale, `V2 · ${who}: фаза ${p.phase} (24 ч) закрыта ${p.ok ? "✓" : "✗"} — итог ${signed(p.net)}, крупнейший рынок ${top}${shield}.`,
      `V2 · ${who}: phase ${p.phase} (24 h) closed ${p.ok ? "✓" : "✗"} — net ${signed(p.net)}, top market ${top}${shield}.`);
    const next = p.phase === 1 && p.ok ? say(locale, "Вселенная пересобрана, идёт фаза 2.", "The universe is rebuilt; phase 2 is under way.")
      : p.phase === 1 ? say(locale, `Вердикт: ${verdictName(p.verdict, locale)}; фаза 2 идёт для справки.`, `Verdict: ${verdictName(p.verdict, locale)}; phase 2 runs for the record.`)
        : say(locale, `Вердикт: ${verdictName(p.verdict, locale)}.`, `Verdict: ${verdictName(p.verdict, locale)}.`);
    return `${head}\n${next}`;
  }
  return null;
}

function watchText(p, locale) {
  const who = `${p.agentId || "?"} ${typeName(p.type, locale)}`;
  if (p.state === "ok") return say(locale, `V2 · ${who}: снова в порядке (${watchName(p.code, locale)} — устранено).`, `V2 · ${who}: back to normal (${watchName(p.code, locale)} — cleared).`);
  const err = p.error ? ` (${netName(p.error, locale)})` : "";
  return say(locale, `V2 · ${who}: ${watchName(p.code, locale)} дольше 3 мин${err}. Тест V2 теряет часы — проверьте сеть и приложение.`,
    `V2 · ${who}: ${watchName(p.code, locale)} for over 3 min${err}. The V2 test is losing hours — check the network and the app.`);
}

function head(s, locale) {
  const state = s.halt ? say(locale, `СТОП: ${haltName(s.halt.reason, locale)}`, `HALTED: ${haltName(s.halt.reason, locale)}`)
    : s.running ? say(locale, "работают", "running") : say(locale, "остановлены", "stopped");
  return say(locale, `Агенты · бумага · ${state}`, `Agents · paper · ${state}`);
}
function money(s, locale) {
  return say(locale,
    `Капитал ${usd(s.equity)} (${signed(s.pnl)} · ${pct(s.pnlPct)}) · сегодня ${signed(s.dayPnl)}`,
    `Equity ${usd(s.equity)} (${signed(s.pnl)} · ${pct(s.pnlPct)}) · today ${signed(s.dayPnl)}`);
}

function statusText(s, locale = "en") {
  if (!s || s.ok === false) return say(locale, `Агенты недоступны: ${s?.reason || s?.error || "?"}`, `Agents unavailable: ${s?.reason || s?.error || "?"}`);
  if (s.error) return say(locale, `Агенты недоступны: ${s.error}. Откройте «Агенты» в приложении — там можно начать заново.`, `Agents unavailable: ${s.error}. Open Agents in the app to start afresh.`);
  const lines = [head(s, locale), money(s, locale),
    say(locale, `Открыто ${s.openPositions} поз. на ${usd(s.exposure)} · кэш ${usd(s.cash)}`, `Open ${s.openPositions} positions for ${usd(s.exposure)} · cash ${usd(s.cash)}`),
    say(locale, `Сделок ${s.trades} · закрыто ${s.settled} · комиссии ${usd(s.feesPaid)}`, `Trades ${s.trades} · settled ${s.settled} · fees ${usd(s.feesPaid)}`)];
  const ai = s.ai || {};
  lines.push(ai.available
    ? say(locale, `ИИ: ${usd(ai.spentUsd)} из ${usd(ai.dailyUsd)} сегодня · ${ai.calls} запр.`, `AI: ${usd(ai.spentUsd)} of ${usd(ai.dailyUsd)} today · ${ai.calls} calls`)
    : say(locale, `ИИ: выключен (${ai.reason || "—"})`, `AI: off (${ai.reason || "—"})`));
  const agents = (s.agents || []).filter((a) => a.status !== "retired" && !a.v2);
  if (agents.length) {
    lines.push(say(locale, "Агенты:", "Agents:"));
    for (const a of agents) {
      const mark = a.status === "paused" ? say(locale, " (пауза)", " (paused)") : "";
      lines.push(` ${a.id} ${typeName(a.type, locale)}${mark}: ${signed(a.pnl)} · ${say(locale, `${a.trades} сд.`, `${a.trades} tr.`)}${a.open ? ` · ${say(locale, `${a.open} откр.`, `${a.open} open`)}` : ""}`);
    }
  }
  lines.push(...v2Lines(s.v2, locale));
  if (s.halt) lines.push(haltHint(s.halt, locale));
  return lines.join("\n");
}

function haltHint(halt, locale) {
  if (halt.reason === "manual") return say(locale, "Снять стоп: /agents_start или в приложении.", "To clear it: /agents_start or the app.");
  if (halt.reason === "daily_loss") return say(locale, "Снимется сам в начале следующих суток UTC или в приложении.", "It clears at the next UTC day or in the app.");
  return say(locale, "Снять стоп можно только в приложении (Агенты → Снять стоп).", "Only the app can clear it (Agents → Clear halt).");
}

function tradeLine(row, locale) {
  const who = `${row.agentId} ${typeName(row.type, locale)}`;
  if (row.kind === "settle") {
    const won = row.pnl > 0 ? "✓" : row.pnl < 0 ? "✗" : "·";
    return `${won} ${who}: ${row.outcome} «${clip(row.label, 60)}» → ${signed(row.pnl)}`;
  }
  const legs = row.legs > 1 ? say(locale, ` (${row.legs} ног)`, ` (${row.legs} legs)`) : "";
  const edge = row.edge != null ? say(locale, ` · перевес ${pct(row.edge)}`, ` · edge ${pct(row.edge)}`) : "";
  return `• ${who}: ${row.outcome} «${clip(row.label, 60)}»${legs} ${usd(row.costUsd)}${row.avg ? ` @ ${Number(row.avg).toFixed(3)}` : ""}${edge}`;
}

function digestText(p, locale = "en") {
  const rows = p.rows || [];
  const trades = rows.filter((r) => r.kind === "trade");
  const settled = rows.filter((r) => r.kind === "settle");
  const lines = [say(locale, `Агенты · сводка за ${p.minutes} мин (бумага)`, `Agents · ${p.minutes}-minute digest (paper)`)];
  if (trades.length) {
    lines.push(say(locale, `Сделки: ${trades.length} на ${usd(trades.reduce((a, r) => a + (r.costUsd || 0), 0))}`, `Trades: ${trades.length} for ${usd(trades.reduce((a, r) => a + (r.costUsd || 0), 0))}`));
    for (const r of trades.slice(0, 10)) lines.push(tradeLine(r, locale));
  }
  if (settled.length) {
    lines.push(say(locale, `Закрыто: ${settled.length} · итог ${signed(settled.reduce((a, r) => a + (r.pnl || 0), 0))}`, `Settled: ${settled.length} · result ${signed(settled.reduce((a, r) => a + (r.pnl || 0), 0))}`));
    for (const r of settled.slice(0, 10)) lines.push(tradeLine(r, locale));
  }
  if (p.count > rows.length) lines.push(say(locale, `…и ещё ${p.count - rows.length}`, `…and ${p.count - rows.length} more`));
  if (p.summary) lines.push(money(p.summary, locale));
  return lines.join("\n");
}

function haltText(p, locale = "en") {
  const h = p.halt || {};
  const why = h.reason === "manual"
    ? say(locale, `вручную (${h.by === "telegram" ? "Telegram" : "приложение"})`, `by hand (${h.by === "telegram" ? "Telegram" : "the app"})`)
    : say(locale, `${haltName(h.reason, locale)}: капитал ${usd(h.equity)} ≤ ${usd(h.limit)}`, `${haltName(h.reason, locale)}: equity ${usd(h.equity)} ≤ ${usd(h.limit)}`);
  return [say(locale, `Агенты остановлены — ${why}.`, `Agents halted — ${why}.`),
    say(locale, "Новые сделки не открываются; открытые бумажные позиции ведутся до итога.", "No new trades; open paper positions are held to resolution."),
    haltHint(h, locale)].join("\n");
}

function rosterText(p, locale = "en") {
  const who = `${p.agentId} ${typeName(p.type, locale)}`;
  const why = reasonText(p.reason, locale);
  if (p.op === "pause") return say(locale, `Агент ${who} на паузе: ${why}.`, `Agent ${who} paused: ${why}.`);
  if (p.op === "retire") return say(locale, `Агент ${who} выведен из команды: ${why}.`, `Agent ${who} retired: ${why}.`);
  if (p.op === "resume") return say(locale, `Агент ${who} снова в работе: ${why}.`, `Agent ${who} is back: ${why}.`);
  if (p.op === "spawn") return say(locale, `Новый агент ${who}: ${why}.`, `New agent ${who}: ${why}.`);
  return `${who}: ${p.op}`;
}

function dailyText(r, locale = "en") {
  if (!r || r.ok === false) return say(locale, "Отчёт агентов недоступен.", "The agents' report is unavailable.");
  const t = r.totals || {};
  const lines = [say(locale, "Агенты · отчёт за сутки (бумага)", "Agents · daily report (paper)"),
    say(locale, `Капитал ${usd(r.equity)} · за период ${signed(t.realized)} реализовано · всего ${signed(r.pnl)}`, `Equity ${usd(r.equity)} · ${signed(t.realized)} realized in the period · ${signed(r.pnl)} overall`),
    say(locale, `Сделок ${t.trades || 0} · закрыто ${t.settled || 0} (в плюс ${t.wins || 0}) · комиссии ${usd(t.fees)}`, `Trades ${t.trades || 0} · settled ${t.settled || 0} (${t.wins || 0} won) · fees ${usd(t.fees)}`)];
  for (const a of (r.agents || []).filter((x) => x.trades || x.settled)) {
    const brier = a.brier != null ? ` · Brier ${a.brier.toFixed(3)}${a.marketBrier != null ? `/${a.marketBrier.toFixed(3)}` : ""}` : "";
    lines.push(` ${a.id} ${typeName(a.type, locale)}: ${say(locale, `${a.trades} сд., закрыто ${a.settled}`, `${a.trades} tr., ${a.settled} settled`)} · ${signed(a.realized)}${brier}`);
  }
  if (r.ai && r.ai.calls) lines.push(say(locale, `ИИ: ${r.ai.calls} запр., ${usd(r.ai.spentUsd)}`, `AI: ${r.ai.calls} calls, ${usd(r.ai.spentUsd)}`));
  if (r.halt) lines.push(say(locale, `Стоп: ${haltName(r.halt.reason, locale)}`, `Halt: ${haltName(r.halt.reason, locale)}`));
  const v = r.v2, rows = v && Array.isArray(v.rows) ? v.rows.filter((x) => x.status !== "retired") : [];
  if (rows.length) {
    lines.push(say(locale, `V2 · отдельный счёт: всего ${signed(v.pnl)}`, `V2 · its own account: ${signed(v.pnl)} overall`));
    for (const x of rows) {
      const what = x.type === "lp_rewards" ? say(locale, `${x.trades} заполн.`, `${x.trades} fills`) : say(locale, `${x.trades} сд., закрыто ${x.settled}`, `${x.trades} tr., ${x.settled} settled`);
      lines.push(` ${x.id} ${typeName(x.type, locale)}: ${what} · ${signed(x.realized)}`);
      lines.push(`   ${certText(x.type, v[x.type] || {}, locale)}`);
    }
    for (const i of (v.issues || []).slice(0, 4)) lines.push(` ⚠ ${i.agentId} ${typeName(i.type, locale)}: ${watchName(i.code, locale)}`);
  }
  return lines.join("\n");
}

// One alert of the desk (an "agents_alert" event) as a Telegram message, or null.
function alertText(payload, locale = "en") {
  if (!payload || typeof payload !== "object") return null;
  let text = null;
  if (payload.kind === "trade" && payload.row) text = `${say(locale, "Агенты (бумага)", "Agents (paper)")}\n${tradeLine(payload.row, locale)}`;
  else if (payload.kind === "digest") text = digestText(payload, locale);
  else if (payload.kind === "halt") text = haltText(payload, locale);
  else if (payload.kind === "roster") text = rosterText(payload, locale);
  else if (payload.kind === "daily") text = dailyText(payload.report, locale);
  else if (payload.kind === "v2") text = v2Text(payload, locale);
  else if (payload.kind === "watch") text = watchText(payload, locale);
  return text ? clip(text, 3800) : null;
}

module.exports = { statusText, digestText, haltText, rosterText, dailyText, alertText, tradeLine, typeName, usd, signed, pct, certText, cents };
