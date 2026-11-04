"use strict";

// The agents: their types, the default roster, and the rules that pause, resume, retire and spawn them.

const TYPES = Object.freeze({
  arb_bundle: { kind: "arb", ai: false, ru: "Арбитраж наборов", en: "Bundle arbitrage",
    about: { ru: "Покупает все исходы события, когда набор «да» дешевле $1 или набор «нет» дешевле N−1: выплата гарантирована.",
      en: "Buys every outcome of an event when the YES set costs less than $1 or the NO set less than N−1: the payout is certain." } },
  arb_ladder: { kind: "arb", ai: false, ru: "Арбитраж лесенок", en: "Ladder arbitrage",
    about: { ru: "Рынки, где один исход включает другой («к марту» ⊂ «к июню»): «да» на шире и «нет» на уже, когда пара дешевле $1.",
      en: "Markets where one outcome includes another (\"by March\" ⊂ \"by June\"): YES on the wider and NO on the narrower when the pair costs under $1." } },
  crypto_levels: { kind: "model", ai: false, ru: "Крипто-уровни", en: "Crypto levels",
    about: { ru: "BTC/ETH/SOL/XRP выше уровня, в диапазоне или касание: страйк, выбившийся из своей лестницы, — логнормальная модель от спота с волатильностью соседних страйков.",
      en: "BTC/ETH/SOL/XRP above a level, in a range or touching it: a strike out of line with its ladder — a lognormal model from spot with the volatility of the neighbouring strikes." } },
  weather: { kind: "model", ai: false, ru: "Погода", en: "Weather",
    about: { ru: "Дневной максимум/минимум по METAR аэропорта: уже наблюдённые часы плюс ансамбль Open-Meteo на оставшиеся.",
      en: "Daily high/low at the airport's METAR station: the hours already observed plus the Open-Meteo ensemble for the rest." } },
  favorites: { kind: "model", ai: false, ru: "Фавориты", en: "Favourites",
    about: { ru: "Фавориты по 90–98¢ с итогом в ближайшие дни (гипотеза favorite-longshot bias); проверяется на бумаге.",
      en: "Favourites priced 90–98¢ resolving within days (the favourite-longshot bias); a hypothesis tested on paper." } },
  resolution: { kind: "ai", ai: true, ru: "Близкий итог", en: "Near resolution",
    about: { ru: "Рынки с итогом ≤72 ч: ИИ по свежим заголовкам проверяет, не решён ли исход уже.",
      en: "Markets resolving within 72 h: the AI checks recent headlines for whether the outcome is already decided." } },
  forecast: { kind: "ai", ai: true, ru: "Прогнозист", en: "Forecaster",
    about: { ru: "ИИ оценивает вероятность по правилам и новостям; оценка сжимается к цене рынка, сделка только при перевесе после комиссии.",
      en: "The AI estimates a probability from the rules and the news; it is shrunk towards the market price and traded only with an edge after fees." } },
  maker: { kind: "shadow", ai: false, ru: "Мейкер (тень)", en: "Maker (shadow)",
    about: { ru: "Виртуальные заявки у лучшей цены на рынках с наградами; исполнение засчитывается только при проходе цены сквозь заявку. Награды не считаются.",
      en: "Virtual quotes at the best price on reward markets; a fill counts only when the price trades through the quote. Rewards are not counted." } },
});

const DEFAULT_PARAMS = Object.freeze({
  favorites: { minPrice: 0.9, maxPrice: 0.98, maxDays: 7, bias: 0.015, minEdge: 0.005 },
  forecast: { minDays: 2, maxDays: 60 },
  weather: { maxLeadDays: 0 },   // the local day under way: the hours already observed anchor the result
});
// A free slot goes to a variant of an agent that earns: a tighter, nearer or (weather) one-day-further version of
// the same idea.
const VARIANTS = Object.freeze({
  favorites: { minPrice: 0.85, maxPrice: 0.95, maxDays: 3, bias: 0.02, minEdge: 0.008 },
  forecast: { minDays: 2, maxDays: 14 },
  weather: { maxLeadDays: 1 },
});
const STATUSES = new Set(["active", "paused", "retired"]);
const RETEST_MS = 72 * 3600000;
// Agents whose probabilities are their own, scored against the market's price at entry (favourites only add a fixed
// bias to the price, arbitrage and the maker carry none).
const BRIER_TYPES = new Set(["crypto_levels", "weather", "resolution", "forecast"]);

function agentFrom(type, id, now, params = DEFAULT_PARAMS[type] || {}, note = null) {
  return { id, type, status: "active", params: { ...params }, createdAt: now, pausedAt: null, pauses: 0, note };
}
function defaultRoster(now) {
  return Object.keys(TYPES).map((type, i) => agentFrom(type, `a${i + 1}`, now));
}
function nextId(roster) {
  return `a${roster.reduce((max, a) => Math.max(max, Number(a.id.slice(1)) || 0), 0) + 1}`;
}

/**
 * Hourly rules. stats[id] = { pnl, settled, brier, marketBrier, brierN }; capital = the agent's share of capital.
 *  - pause: a loss of 30% of its capital, or ≥ 20 settled trades and a loss of 10%; an agent with probabilities of
 *    its own (the models and the AI) also when its Brier score trails the market's by 0.02 after 30 settled trades;
 *  - a rule-paused agent is retested after 72 hours; paused a second time, it retires and frees its slot;
 *  - a free slot (active + paused < maxAgents) goes to the variant of the best earner: ≥ 20 settled, ≥ +5%.
 */
function evaluateRoster(roster, stats, config, now) {
  const capital = (config.agentCapitalPct / 100) * config.capitalUsd;
  const actions = [];
  for (const agent of roster) {
    const s = stats[agent.id] || { pnl: 0, settled: 0 };
    if (agent.status === "active") {
      let reason = null;
      if (s.pnl <= -0.3 * capital) reason = "loss_30";
      else if (s.settled >= 20 && s.pnl <= -0.1 * capital) reason = "loss_10_after_20";
      else if (BRIER_TYPES.has(agent.type) && s.brierN >= 30 && s.brier > s.marketBrier + 0.02) reason = "brier_worse_than_market";
      if (reason) actions.push({ op: agent.pauses >= 1 ? "retire" : "pause", agentId: agent.id, reason });
    } else if (agent.status === "paused" && agent.note !== "manual" && agent.pausedAt && now - agent.pausedAt >= RETEST_MS) {
      actions.push({ op: "resume", agentId: agent.id, reason: "retest_after_72h" });
    }
  }
  const occupied = roster.filter((a) => a.status !== "retired").length - actions.filter((a) => a.op === "retire").length;
  if (occupied < config.maxAgents) {
    const best = roster.filter((a) => a.status === "active" && VARIANTS[a.type])
      .map((a) => ({ a, s: stats[a.id] || { pnl: 0, settled: 0 } }))
      .filter(({ a, s }) => s.settled >= 20 && s.pnl >= 0.05 * capital && !roster.some((b) => b.type === a.type && b.status !== "retired" && JSON.stringify(b.params) === JSON.stringify(VARIANTS[a.type])))
      .sort((x, y) => y.s.pnl - x.s.pnl)[0];
    if (best) actions.push({ op: "spawn", type: best.a.type, params: VARIANTS[best.a.type], reason: `variant_of_${best.a.id}` });
  }
  return actions;
}

// A model's roster suggestion is applied only when the rules would allow it: pausing is always allowed (the safe
// direction); resuming needs a rule pause older than 24 h; spawning needs a free slot and a listed variant.
function allowSuggestion(action, roster, config, now) {
  if (!action || typeof action !== "object") return { ok: false, reason: "invalid" };
  if (action.op === "pause") {
    const agent = roster.find((a) => a.id === action.agent && a.status === "active");
    return agent ? { ok: true, action: { op: "pause", agentId: agent.id, reason: "ai_plan" } } : { ok: false, reason: "not_active" };
  }
  if (action.op === "resume") {
    const agent = roster.find((a) => a.id === action.agent && a.status === "paused");
    if (!agent) return { ok: false, reason: "not_paused" };
    if (agent.note === "manual" || !agent.pausedAt || now - agent.pausedAt < 24 * 3600000) return { ok: false, reason: "too_early" };
    return { ok: true, action: { op: "resume", agentId: agent.id, reason: "ai_plan" } };
  }
  if (action.op === "spawn") {
    const type = action.agent;
    if (!VARIANTS[type]) return { ok: false, reason: "no_variant" };
    if (roster.filter((a) => a.status !== "retired").length >= config.maxAgents) return { ok: false, reason: "no_slot" };
    if (roster.some((a) => a.type === type && a.status !== "retired" && JSON.stringify(a.params) === JSON.stringify(VARIANTS[type]))) return { ok: false, reason: "exists" };
    return { ok: true, action: { op: "spawn", type, params: VARIANTS[type], reason: "ai_plan" } };
  }
  return { ok: false, reason: "invalid" };
}

function applyRoster(roster, action, now) {
  if (action.op === "spawn") {
    const agent = agentFrom(action.type, nextId(roster), now, action.params, action.reason);
    roster.push(agent);
    return agent;
  }
  const agent = roster.find((a) => a.id === action.agentId);
  if (!agent) return null;
  if (action.op === "pause") { agent.status = "paused"; agent.pausedAt = now; agent.pauses += 1; agent.note = action.reason; }
  else if (action.op === "retire") { agent.status = "retired"; agent.pausedAt = now; agent.note = action.reason; }
  else if (action.op === "resume") { agent.status = "active"; agent.pausedAt = null; agent.note = action.reason; }
  return agent;
}

module.exports = { TYPES, DEFAULT_PARAMS, VARIANTS, STATUSES, defaultRoster, evaluateRoster, allowSuggestion, applyRoster, nextId };
