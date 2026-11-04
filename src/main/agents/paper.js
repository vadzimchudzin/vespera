"use strict";

// The desk's only executor: paper fills against real order books. A buy walks the asks level by level, pays the
// market's taker fee on every level and is held to resolution, where each share pays its outcome's final price.
// Nothing here can reach a venue.

const { takerFee } = require("../fees");

const MAX_CLOSED = 500;
const MAX_OPEN = 400;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r2 = (x) => Math.round(x * 100) / 100;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// All-in cost of `shares` from best-first asks, or null when the depth is short.
function walkCost(asks, shares, fee) {
  let left = shares, cost = 0, fees = 0;
  for (const [price, size] of asks) {
    if (left <= 1e-9) break;
    const take = Math.min(left, size);
    cost += take * price;
    fees += takerFee(take, price, fee);
    left -= take;
  }
  return left > 1e-9 ? null : { cost, fees };
}

// Buys up to `shares` (and up to `budgetUsd` with fees) from best-first asks, never above `limit`. Shares are whole
// hundredths; below the book's minimum size there is no fill.
function simulateBuy(asks, { shares = Infinity, budgetUsd = Infinity, limit = 1, fee, minSize = 0 } = {}) {
  let filled = 0, cost = 0, fees = 0, worst = null;
  for (const [price, size] of asks) {
    if (price > limit + 1e-9 || filled >= shares - 1e-9) break;
    const unit = price + takerFee(1, price, fee);
    const room = (budgetUsd - cost - fees) / unit;
    const take = Math.floor(Math.min(size, shares - filled, room) * 100) / 100;
    if (take <= 0) break;
    cost += take * price;
    fees += takerFee(take, price, fee);
    filled += take;
    worst = price;
  }
  if (filled <= 0 || filled < minSize - 1e-9) return null;
  return { shares: r2(filled), cost: r6(cost), fees: r6(fees), avg: cost / filled, worst };
}

function freshBook(capitalUsd, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    cash: capitalUsd, startCapital: capitalUsd, peakEquity: capitalUsd, day, dayStartEquity: capitalUsd,
    positions: [], closed: [], realized: {}, feesPaid: 0, trades: 0, seq: 0, brier: {},
  };
}

class PaperBook {
  constructor(state) { this.s = state; }

  open({ agentId, type, src, event, market, side, fill, prob = null, marketProb = null, group = null, now }) {
    const total = fill.cost + fill.fees;
    if (total > this.s.cash + 1e-9) throw fail("agents_cash_insufficient");
    const token = side === "yes" ? market.yes : market.no;
    const outcome = side === "yes" ? 0 : 1;
    this.s.cash = r6(this.s.cash - total);
    this.s.trades += 1;
    this.s.feesPaid = r6(this.s.feesPaid + fill.fees);
    let position = this.s.positions.find((p) => p.agentId === agentId && p.tokenId === token);
    if (position) {
      const shares = position.shares + fill.shares;
      if (prob != null && position.prob != null) position.prob = r6((position.prob * position.shares + prob * fill.shares) / shares);
      position.shares = r2(shares);
      position.cost = r6(position.cost + fill.cost);
      position.fees = r6(position.fees + fill.fees);
      position.entry = r6(position.cost / position.shares);
    } else {
      if (this.s.positions.length >= MAX_OPEN) throw fail("agents_too_many_positions");
      position = {
        id: `p${++this.s.seq}`, agentId, type, src, group,
        eventId: event.id, match: event.match || `ev:${event.id}`, eventSlug: event.slug, eventTitle: event.title.slice(0, 160), sector: event.sector,
        marketId: market.id, conditionId: market.conditionId, tokenId: token, outcome,
        outcomeLabel: market.outcomes[outcome], label: market.label.slice(0, 120),
        shares: fill.shares, cost: fill.cost, fees: fill.fees, entry: r6(fill.cost / fill.shares),
        openedAt: now, endDate: market.endDate || event.endDate || null,
        prob, marketProb, mark: r6(fill.avg), markAt: now, mo5: null, mo60: null,
      };
      this.s.positions.push(position);
    }
    return position;
  }

  // Marks for valuation: the mid when the spread is tight, else the bid (what the shares would fetch now).
  mark(token, bid, ask, now) {
    for (const p of this.s.positions) {
      if (p.tokenId !== token) continue;
      const value = bid != null && ask != null && ask - bid <= 0.1 ? (bid + ask) / 2 : bid != null ? bid : p.mark;
      p.mark = r6(value);
      p.markAt = now;
    }
  }

  // Pays out every open position on a resolved market at its outcome's final price (1, 0, or 0.5 for a split).
  settle(conditionId, prices, now) {
    const done = [];
    for (const p of this.s.positions.filter((row) => row.conditionId === conditionId)) {
      const y = prices[p.outcome];
      const payout = r6(p.shares * y);
      const pnl = r6(payout - p.cost - p.fees);
      this.s.cash = r6(this.s.cash + payout);
      this.s.realized[p.agentId] = r6((this.s.realized[p.agentId] || 0) + pnl);
      if (p.prob != null) {
        const b = this.s.brier[p.agentId] || (this.s.brier[p.agentId] = { n: 0, sum: 0, market: 0 });
        b.n += 1;
        b.sum = r6(b.sum + (p.prob - y) ** 2);
        b.market = r6(b.market + ((p.marketProb ?? p.entry) - y) ** 2);
      }
      const row = { ...p, closedAt: now, payout, pnl, result: y };
      done.push(row);
      this.s.closed.push(row);
    }
    if (done.length) {
      this.s.positions = this.s.positions.filter((row) => row.conditionId !== conditionId);
      this.s.closed = this.s.closed.slice(-MAX_CLOSED);
    }
    return done;
  }

  equity() { return r6(this.s.cash + this.s.positions.reduce((sum, p) => sum + p.shares * p.mark, 0)); }
  exposure(filter = () => true) { return r6(this.s.positions.filter(filter).reduce((sum, p) => sum + p.cost + p.fees, 0)); }
  unrealized(filter = () => true) { return r6(this.s.positions.filter(filter).reduce((sum, p) => sum + p.shares * p.mark - p.cost - p.fees, 0)); }
}

module.exports = { PaperBook, freshBook, walkCost, simulateBuy, MAX_CLOSED, MAX_OPEN };
