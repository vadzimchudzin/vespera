"use strict";

const { Decimal } = require("./money");
const { CRYPTO_TAKER_RATE, ASSUMED_PRICE, num, validPrice, takerFeeOnStake } = require("./fees");

/** Polymarket Up/Down rule: end >= start is UP. */
function outcomeOf(close, strike) {
  return Number(close) >= Number(strike) ? "UP" : "DOWN";
}

/**
 * Paper venue that books exactly what Polymarket would: entry at the ask,
 * $1 per winning share, and the taker fee on top of the stake. Without a live
 * quote it assumes even odds (0.50) and charges the fee at that price, so an
 * offline run is never more optimistic than the venue.
 */
class PaperBroker {
  constructor(options = {}) {
    this.startingBalance = Decimal(options.startingBalance ?? "1000.00");
    this.balance = Decimal(this.startingBalance);
    this.openBet = null;
    this.history = [];
    this.connected = true;
    this.takerFeeRate = Number(options.takerFeeRate ?? CRYPTO_TAKER_RATE);
  }

  async ping() {
    return {
      ok: true,
      venue: "paper",
      latencyMs: 4,
      message: "Paper venue ready",
    };
  }

  async getBalance() {
    return this.balance.toFixed(2);
  }

  feeOn(sizeUsd, price, schedule = {}) {
    const p = validPrice(price) ?? ASSUMED_PRICE;
    const rate = num(schedule.rate) ?? this.takerFeeRate;
    return takerFeeOnStake(Decimal(sizeUsd).toNumber(), p, { rate, exponent: schedule.exponent });
  }

  reset(startingBalance) {
    if (startingBalance != null) this.startingBalance = Decimal(startingBalance);
    this.balance = Decimal(this.startingBalance);
    this.openBet = null;
    this.history = [];
    return this.snapshot();
  }

  async marketBuy({ side, sizeUsd, clientOrderId, round, price, quoteSource, feeRate, feeExponent }) {
    if (this.openBet) {
      throw new Error("already_open");
    }
    const size = Decimal(sizeUsd);
    const live = validPrice(price);
    const entry = live ?? ASSUMED_PRICE;
    const rate = num(feeRate) ?? this.takerFeeRate;
    const feeExact = this.feeOn(size, entry, { rate, exponent: feeExponent });
    // the balance is kept in cents; charge the fee rounded up so paper never under-counts it
    const fee = Decimal(Math.ceil(feeExact * 100 - 1e-9) / 100);
    const cost = size.add(fee);
    if (!this.balance.gte(cost)) {
      const err = new Error("insufficient_balance");
      err.code = "insufficient_balance";
      throw err;
    }
    this.balance = this.balance.sub(cost);
    const placedAt = Date.now();
    this.openBet = {
      clientOrderId,
      side,
      // Polymarket pays $1 per winning share: shares = stake / price
      payout: 1 / entry,
      shares: Number((size.toNumber() / entry).toFixed(4)),
      entryPrice: entry,
      quoteSource: live != null ? quoteSource || "polymarket" : "assumed_0.50",
      sizeUsd: size.toFixed(2),
      feeUsd: fee.toFixed(2),
      feeRate: rate,
      strike: round.strike,
      fillPrice: round.strike,
      roundOpenTs: round.openTs,
      roundCloseTs: round.closeTs,
      placedAt,
      openedAtIso: new Date(placedAt).toISOString(),
      status: "open",
    };
    return { ...this.openBet, accepted: true, balanceAfter: this.balance.toFixed(2) };
  }

  /**
   * TZ: signal on closed S, bet on S+1. Settle when S+1 closes vs strike (close of S).
   * Flat (close === strike) resolves UP, as Polymarket's ">= start price" rule does.
   */
  settle(nextBar) {
    if (!this.openBet) return null;
    if (this.openBet.roundCloseTs && nextBar.closeTs && nextBar.closeTs < this.openBet.roundCloseTs) {
      return null;
    }
    const strike = Number(this.openBet.strike);
    const close = Number(nextBar.close);
    const outcome = outcomeOf(close, strike);

    const won = this.openBet.side === outcome;
    const size = Decimal(this.openBet.sizeUsd);
    const fee = Decimal(this.openBet.feeUsd || "0");
    const shares = Number(this.openBet.shares) > 0
      ? Number(this.openBet.shares)
      : size.toNumber() * (Number(this.openBet.payout) > 1 ? Number(this.openBet.payout) : 2);
    let pnl = size.add(fee).mul(-1);
    if (won) {
      const gross = Decimal(shares);
      this.balance = this.balance.add(gross);
      pnl = gross.sub(size).sub(fee);
    }

    const settled = {
      ...this.openBet,
      status: won ? "win" : "loss",
      outcome,
      settleClose: close,
      settledAt: Date.now(),
      holdMs: Date.now() - this.openBet.placedAt,
      pnl: pnl.toFixed(2),
      balanceAfter: this.balance.toFixed(2),
    };
    this.history.unshift(settled);
    this.openBet = null;
    return settled;
  }

  snapshot() {
    return {
      venue: "paper",
      balance: this.balance.toFixed(2),
      startingBalance: this.startingBalance.toFixed(2),
      openBet: this.openBet,
      last: this.history[0] || null,
      feeRate: this.takerFeeRate,
    };
  }
}

module.exports = { PaperBroker, outcomeOf };
