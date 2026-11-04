"use strict";

// Texts of the agents desk for Telegram: status, the trade digest, roster changes, halt alerts and the daily report,
// in Russian or English. Plain text built from the desk's own numbers; everything here is paper.

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
};
const reasonText = (reason, locale) => {
  if (REASONS[reason]) return say(locale, ...REASONS[reason]);
  const variant = /^variant_of_(a\d+)$/.exec(reason || "");
  if (variant) return say(locale, `вариант ${variant[1]}, который зарабатывает`, `a variant of ${variant[1]}, which earns`);
  return String(reason || "");
};
const haltName = (reason, locale) => (HALTS[reason] ? say(locale, ...HALTS[reason]) : String(reason || "?"));

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
  const agents = (s.agents || []).filter((a) => a.status !== "retired");
  if (agents.length) {
    lines.push(say(locale, "Агенты:", "Agents:"));
    for (const a of agents) {
      const mark = a.status === "paused" ? say(locale, " (пауза)", " (paused)") : "";
      lines.push(` ${a.id} ${typeName(a.type, locale)}${mark}: ${signed(a.pnl)} · ${say(locale, `${a.trades} сд.`, `${a.trades} tr.`)}${a.open ? ` · ${say(locale, `${a.open} откр.`, `${a.open} open`)}` : ""}`);
    }
  }
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
  return text ? clip(text, 3800) : null;
}

module.exports = { statusText, digestText, haltText, rosterText, dailyText, alertText, tradeLine, typeName, usd, signed, pct };
