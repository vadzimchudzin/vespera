"use strict";

const { Decimal } = require("./money");
const { CRYPTO_TAKER_RATE, DEFAULT_EXPONENT, ASSUMED_PRICE, num, validPrice } = require("./fees");

const SIZING_MODES = ["double", "recover"];

/**
 * Net profit per $1 staked on a win and net cost per $1 on a loss, at entry
 * price p with the Polymarket taker fee (fee per $ = rate × (p(1−p))^e / p).
 */
function perDollar(price, { rate = CRYPTO_TAKER_RATE, exponent = DEFAULT_EXPONENT } = {}) {
  const p = validPrice(price) ?? ASSUMED_PRICE;
  const r = num(rate) != null && num(rate) >= 0 ? num(rate) : CRYPTO_TAKER_RATE;
  const e = num(exponent) != null && num(exponent) > 0 ? num(exponent) : DEFAULT_EXPONENT;
  const fee = (r * Math.pow(p * (1 - p), e)) / p;
  return { price: p, win: 1 / p - 1 - fee, loss: 1 + fee, fee };
}

/** Win rate needed to break even at this price: loss / (win + loss). */
function breakEvenWinRate(price, schedule) {
  const k = perDollar(price, schedule);
  return k.win > 0 ? k.loss / (k.win + k.loss) : 1;
}

/**
 * Martingale series.
 *  - double:  stake = base × 2^(step−1), the classic ×2.
 *  - recover: stake sized so a win at the current price, after the taker fee,
 *             pays back every loss of the series and still makes the base
 *             profit: stake = base + seriesLoss / netWinPerDollar.
 * A ×2 series does not recover at Polymarket odds (payout 1/price, fee on
 * both outcomes); "recover" does, at the cost of faster-growing stakes.
 */
class Risk {
  constructor(options = {}) {
    this.baseUsd = Decimal(options.baseUsd ?? "1.00");
    this.maxSteps = Number(options.maxSteps ?? 6);
    this.sizingMode = SIZING_MODES.includes(options.sizingMode) ? options.sizingMode : "double";
    // 0 = no cap
    this.maxStakeUsd = Math.max(0, Number(options.maxStakeUsd) || 0);
    this.step = 1;
    this.consecutiveLosses = 0;
    this.seriesLossUsd = 0;
    this.halted = false;
    this.lotConfirmed = true;
  }

  configure({ baseUsd, maxSteps, sizingMode, maxStakeUsd } = {}) {
    if (baseUsd != null) this.baseUsd = Decimal(baseUsd);
    if (maxSteps != null) this.maxSteps = Math.max(1, Number(maxSteps) || 1);
    if (sizingMode != null && SIZING_MODES.includes(sizingMode)) this.sizingMode = sizingMode;
    if (maxStakeUsd != null) this.maxStakeUsd = Math.max(0, Number(maxStakeUsd) || 0);
    return this;
  }

  /** Stake before the cap, for the current step and an entry price. */
  rawSize(price, schedule) {
    if (this.sizingMode === "recover") {
      const k = perDollar(price, schedule);
      if (k.win <= 0) return this.baseUsd.toNumber();
      return this.baseUsd.toNumber() + this.seriesLossUsd / k.win;
    }
    return this.baseUsd.toNumber() * 2 ** (this.step - 1);
  }

  /** Stake rounded up to the cent (recovery must not fall short), then capped. */
  size(price, schedule) {
    const raw = Math.ceil(this.rawSize(price, schedule) * 100 - 1e-6) / 100;
    const capped = this.maxStakeUsd > 0 ? Math.min(raw, this.maxStakeUsd) : raw;
    return Decimal(capped);
  }

  isCapped(price, schedule) {
    return this.maxStakeUsd > 0 && this.rawSize(price, schedule) > this.maxStakeUsd + 1e-9;
  }

  canOpen() {
    return !this.halted && this.step <= this.maxSteps && this.lotConfirmed;
  }

  onWin() {
    this.step = 1;
    this.consecutiveLosses = 0;
    this.seriesLossUsd = 0;
    this.halted = false;
  }

  /** @param {number|string} lossUsd what the lost bet cost, stake + fee (positive) */
  onLoss(lossUsd = 0) {
    const cost = Math.abs(Number(lossUsd) || 0);
    this.seriesLossUsd += cost;
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
      this.reset();
    }
  }

  reset() {
    this.step = 1;
    this.consecutiveLosses = 0;
    this.seriesLossUsd = 0;
    this.halted = false;
  }

  /**
   * Stakes if every step of a fresh series loses, at one assumed price.
   * Shows what a full losing series really costs before it happens.
   */
  plan(price, schedule) {
    const sim = new Risk({
      baseUsd: this.baseUsd.toFixed(2),
      maxSteps: this.maxSteps,
      sizingMode: this.sizingMode,
      maxStakeUsd: this.maxStakeUsd,
    });
    const k = perDollar(price, schedule);
    const steps = [];
    let atRisk = 0;
    for (let i = 0; i < this.maxSteps; i += 1) {
      const stake = sim.size(k.price, schedule).toNumber();
      const lossCost = stake * k.loss;
      steps.push({
        step: i + 1,
        stake: Number(stake.toFixed(2)),
        winNet: Number((stake * k.win - atRisk).toFixed(2)),
        capped: sim.isCapped(k.price, schedule),
      });
      atRisk += lossCost;
      sim.onLoss(lossCost);
    }
    return {
      price: k.price,
      sizingMode: this.sizingMode,
      steps,
      totalAtRisk: Number(atRisk.toFixed(2)),
      breakEvenWinRate: Number(breakEvenWinRate(k.price, schedule).toFixed(4)),
    };
  }

  snapshot(price, schedule) {
    return {
      baseUsd: this.baseUsd.toFixed(2),
      step: this.step,
      maxSteps: this.maxSteps,
      sizingMode: this.sizingMode,
      maxStakeUsd: this.maxStakeUsd,
      size: this.size(price, schedule).toFixed(2),
      seriesLossUsd: this.seriesLossUsd.toFixed(2),
      consecutiveLosses: this.consecutiveLosses,
      halted: this.halted,
      lotConfirmed: this.lotConfirmed,
    };
  }
}

module.exports = { Risk, SIZING_MODES, perDollar, breakEvenWinRate };
