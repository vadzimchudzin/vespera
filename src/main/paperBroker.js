"use strict";

const { Decimal } = require("./money");

/**
 * Paper broker — same interface as a live Preddy adapter.
 * Settles UP/DOWN against the next closed 15m candle vs the round strike (open of S+1).
 */
class PaperBroker {
  constructor(options = {}) {
    this.balance = Decimal(options.startingBalance ?? "1000.00");
    this.openBet = null;
    this.history = [];
    this.connected = true;
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

  async marketBuy({ side, sizeUsd, clientOrderId, round }) {
    if (this.openBet) {
      throw new Error("already_open");
    }
    const size = Decimal(sizeUsd);
    if (!this.balance.gte(size)) {
      const err = new Error("insufficient_balance");
      err.code = "insufficient_balance";
      throw err;
    }
    this.balance = this.balance.sub(size);
    this.openBet = {
      clientOrderId,
      side, // UP | DOWN
      sizeUsd: size.toFixed(2),
      strike: round.strike,
      roundOpenTs: round.openTs,
      roundCloseTs: round.closeTs,
      placedAt: Date.now(),
      status: "open",
    };
    return { ...this.openBet, accepted: true };
  }

  /**
   * Settle against closed next bar. Flat (close === strike) is a loss (TZ + Chainlink-style third outcome).
   */
  settle(nextBar) {
    if (!this.openBet) return null;
    const strike = Number(this.openBet.strike);
    const close = Number(nextBar.close);
    let outcome = "FLAT";
    if (close > strike) outcome = "UP";
    else if (close < strike) outcome = "DOWN";

    const won = this.openBet.side === outcome;
    const size = Decimal(this.openBet.sizeUsd);
    let pnl = size.mul(-1);
    if (won) {
      // Binary paper fill at 0.50: stake returns 2x (stake + 1R). No Preddy 0.5% fee in paper.
      this.balance = this.balance.add(size.mul(2));
      pnl = size;
    }

    const settled = {
      ...this.openBet,
      status: won ? "win" : "loss",
      outcome,
      settleClose: close,
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
      openBet: this.openBet,
      last: this.history[0] || null,
    };
  }
}

module.exports = { PaperBroker };
