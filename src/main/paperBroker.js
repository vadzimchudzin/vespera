"use strict";

const { Decimal } = require("./money");

const FEE_RATE = 0.005;

class PaperBroker {
  constructor(options = {}) {
    this.startingBalance = Decimal(options.startingBalance ?? "1000.00");
    this.balance = Decimal(this.startingBalance);
    this.openBet = null;
    this.history = [];
    this.connected = true;
    this.feeRate = Number(options.feeRate ?? FEE_RATE);
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

  feeOn(sizeUsd) {
    const size = Decimal(sizeUsd);
    return Decimal(size.toNumber() * this.feeRate);
  }

  reset(startingBalance) {
    if (startingBalance != null) this.startingBalance = Decimal(startingBalance);
    this.balance = Decimal(this.startingBalance);
    this.openBet = null;
    this.history = [];
    return this.snapshot();
  }

  async marketBuy({ side, sizeUsd, clientOrderId, round, payout, price, quoteSource }) {
    if (this.openBet) {
      throw new Error("already_open");
    }
    const size = Decimal(sizeUsd);
    const fee = this.feeOn(size);
    const cost = size.add(fee);
    if (!this.balance.gte(cost)) {
      const err = new Error("insufficient_balance");
      err.code = "insufficient_balance";
      throw err;
    }
    this.balance = this.balance.sub(cost);
    const placedAt = Date.now();
    // Polymarket pays $1 per winning share, so the multiple is 1/price.
    // Falls back to the old flat x2 only when no live quote was available.
    const mult = Number(payout);
    this.openBet = {
      clientOrderId,
      side,
      payout: Number.isFinite(mult) && mult > 1 ? mult : 2,
      entryPrice: Number.isFinite(Number(price)) ? Number(price) : null,
      quoteSource: quoteSource || "fixed_2x",
      sizeUsd: size.toFixed(2),
      feeUsd: fee.toFixed(2),
      feeRate: this.feeRate,
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
   * Flat (close === strike) is a loss.
   */
  settle(nextBar) {
    if (!this.openBet) return null;
    if (this.openBet.roundCloseTs && nextBar.closeTs && nextBar.closeTs < this.openBet.roundCloseTs) {
      return null;
    }
    const strike = Number(this.openBet.strike);
    const close = Number(nextBar.close);
    let outcome = "FLAT";
    if (close > strike) outcome = "UP";
    else if (close < strike) outcome = "DOWN";

    const won = this.openBet.side === outcome;
    const size = Decimal(this.openBet.sizeUsd);
    const fee = Decimal(this.openBet.feeUsd || "0");
    const payoutMult = Number(this.openBet.payout) > 1 ? Number(this.openBet.payout) : 2;
    let pnl = size.add(fee).mul(-1);
    if (won) {
      const gross = size.mul(payoutMult);
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
      feeRate: this.feeRate,
    };
  }
}

module.exports = { PaperBroker, FEE_RATE };
