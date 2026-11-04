"use strict";

// Sizing and limits of the agents desk. Every number that bounds a paper trade lives here, so the journal can name
// the limit that decided a size.

// Kelly fraction for a contract bought at all-in cost c (price + fee per share) that pays 1 with probability p:
// f* = (p − c) / (1 − c) of the bankroll. The desk stakes `fraction` of it (a quarter by default).
function kellyStake({ p, cost, bankroll, fraction }) {
  if (!(cost > 0 && cost < 1) || !(p > cost) || !(bankroll > 0)) return 0;
  return Math.max(0, bankroll * fraction * ((p - cost) / (1 - cost)));
}

// The match of an event or of a position (positions opened before matches were kept: their own event).
const matchOfEvent = (event) => event.match || `ev:${event.id}`;
const matchOfPosition = (p) => p.match || `ev:${p.eventId}`;
// Outside arbitrage one agent holds at most this many markets of one match: the totals, handicaps and halves of a
// game are one bet on how the game goes, not several independent ones.
const MAX_PER_MATCH = 3;
function matchCount(book, agentId, event, marketId) {
  const match = matchOfEvent(event);
  const held = book.s.positions.filter((p) => p.agentId === agentId && p.marketId !== marketId && matchOfPosition(p) === match);
  return new Set(held.map((p) => p.marketId)).size;
}

// Dollars a new trade may still use, and which limit binds. Exposure counts cost plus fees of open positions; the
// per-event limit counts every event of the same match.
function capacity({ config, book, equity, agentId, event, market = null, arbitrage = false }) {
  const used = (filter) => book.exposure(filter);
  const match = matchOfEvent(event);
  const limits = [
    ["trade", arbitrage ? config.perEventUsd : config.perTradeUsd],
    ["event", config.perEventUsd - used((p) => matchOfPosition(p) === match)],
    ["sector", (config.sectorMaxPct / 100) * equity - used((p) => p.sector === event.sector)],
    ["total", (config.exposureMaxPct / 100) * equity - used()],
    ["agent", (config.agentCapitalPct / 100) * config.capitalUsd - used((p) => p.agentId === agentId)],
    ["cash", book.s.cash],
  ];
  if (market) limits.push(["market", config.perMarketUsd - used((p) => p.marketId === market.id)]);
  let usd = Infinity, binding = null;
  for (const [name, value] of limits) {
    if (value < usd) { usd = value; binding = name; }
  }
  // a bundle buys every market of an event: each leg stays within the per-market limit
  const legUsd = config.perMarketUsd;
  return { usd: Math.max(0, usd), binding, legUsd };
}

// The limits by name, as the journal and the settings call them: [ru, en].
const LIMIT_NAMES = Object.freeze({
  trade: ["на сделку", "per trade"], market: ["на рынок", "per market"], event: ["на событие", "per event"], sector: ["на сектор", "per sector"],
  total: ["всего в позициях", "total exposure"], agent: ["капитал агента", "agent capital"], cash: ["кэш", "cash"],
});
const limitName = (binding, en = false) => (LIMIT_NAMES[binding] || [String(binding), String(binding)])[en ? 1 : 0];

// The automatic stops: the day's loss against the day's opening equity, and the drawdown from the peak.
function haltCheck({ config, equity, dayStartEquity, peakEquity }) {
  if (equity <= dayStartEquity * (1 - config.dailyLossPct / 100)) return { reason: "daily_loss", equity, limit: dayStartEquity * (1 - config.dailyLossPct / 100) };
  if (equity <= peakEquity * (1 - config.drawdownPct / 100)) return { reason: "drawdown", equity, limit: peakEquity * (1 - config.drawdownPct / 100) };
  return null;
}

module.exports = { kellyStake, capacity, haltCheck, limitName, MAX_PER_MATCH, matchCount, matchOfEvent, matchOfPosition };
