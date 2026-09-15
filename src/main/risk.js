"use strict";

const { Decimal } = require("./money");

class Risk {
  constructor(options = {}) {
    this.baseUsd = Decimal(options.baseUsd ?? "1.00");
    this.maxSteps = Number(options.maxSteps ?? 6);
    this.step = 1;
    this.consecutiveLosses = 0;
    this.halted = false;
    this.lotConfirmed = true;
  }

  size() {
    const multiplier = 2 ** (this.step - 1);
    return this.baseUsd.mul(multiplier);
  }

  canOpen() {
    return !this.halted && this.step <= this.maxSteps && this.lotConfirmed;
  }

  onWin() {
    this.step = 1;
    this.consecutiveLosses = 0;
    this.halted = false;
  }

  onLoss() {
    this.consecutiveLosses += 1;
    if (this.consecutiveLosses >= this.maxSteps) {
      this.halted = true;
      this.lotConfirmed = false;
      return { halt: true };
    }
    this.step += 1;
    return { halt: false };
  }

  onSkip() {
    // skip does not change the series
  }

  confirmLot(baseUsd) {
    this.baseUsd = Decimal(baseUsd);
    this.lotConfirmed = true;
    if (this.halted) {
      this.step = 1;
      this.consecutiveLosses = 0;
      this.halted = false;
    }
  }

  snapshot() {
    return {
      baseUsd: this.baseUsd.toFixed(2),
      step: this.step,
      maxSteps: this.maxSteps,
      size: this.size().toFixed(2),
      consecutiveLosses: this.consecutiveLosses,
      halted: this.halted,
      lotConfirmed: this.lotConfirmed,
    };
  }
}

module.exports = { Risk };
