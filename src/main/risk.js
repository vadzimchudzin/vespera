"use strict";

const { Decimal } = require("./money");
const { CRYPTO_TAKER_RATE, DEFAULT_EXPONENT, ASSUMED_PRICE, num, validPrice } = require("./fees");
const { normalizeSettings } = require("../shared/settings");

const SIZING_MODES = ["double", "fixed", "recover"];
const DEFAULT_FIXED_STAKES = [1, 2, 4, 8, 16, 32];

function centsCeiling(value) {
  return Math.ceil((Number(value) || 0) * 100 - 1e-8) / 100;
}

function asSettings(risk) {
  return {
    baseUsd: risk.baseUsd.toFixed(2),
    maxSteps: risk.maxSteps,
    sizingMode: risk.sizingMode,
    fixedStakes: risk.fixedStakes.slice(),
    maxStakeUsd: risk.maxStakeUsd,
    maxSeriesLossUsd: risk.maxSeriesLossUsd,
  };
}

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
    const normalized = normalizeSettings(options, {
      baseUsd: "1.00",
      maxSteps: 6,
      sizingMode: "double",
      fixedStakes: DEFAULT_FIXED_STAKES,
      maxStakeUsd: 0,
      maxSeriesLossUsd: 0,
    }, { strict: false });
    const settings = {
      baseUsd: "1.00",
      maxSteps: 6,
      sizingMode: "double",
      fixedStakes: DEFAULT_FIXED_STAKES,
      maxStakeUsd: 0,
      maxSeriesLossUsd: 0,
      ...normalized,
    };
    this.baseUsd = Decimal(settings.baseUsd);
    this.maxSteps = settings.maxSteps;
    this.sizingMode = settings.sizingMode;
    this.fixedStakes = settings.fixedStakes.slice();
    // 0 = no cap
    this.maxStakeUsd = settings.maxStakeUsd;
    this.maxSeriesLossUsd = settings.maxSeriesLossUsd;
    this.step = 1;
    this.consecutiveLosses = 0;
    this.seriesLossUsd = 0;
    this.halted = false;
    this.lotConfirmed = true;
  }

  configure(patch = {}) {
    const settings = normalizeSettings(patch, asSettings(this), { strict: true });
    if (settings.baseUsd != null) this.baseUsd = Decimal(settings.baseUsd);
    if (settings.maxSteps != null) this.maxSteps = settings.maxSteps;
    if (settings.sizingMode != null) this.sizingMode = settings.sizingMode;
    if (settings.fixedStakes != null) this.fixedStakes = settings.fixedStakes.slice();
    if (settings.maxStakeUsd != null) this.maxStakeUsd = settings.maxStakeUsd;
    if (settings.maxSeriesLossUsd != null) this.maxSeriesLossUsd = settings.maxSeriesLossUsd;
    return this;
  }

  /** Stake before the cap, for the current step and an entry price. */
  rawSize(price, schedule) {
    if (this.sizingMode === "fixed") {
      return this.fixedStakes[Math.min(this.step - 1, this.fixedStakes.length - 1)];
    }
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

  budgetAllows(price, schedule) {
    if (this.maxSeriesLossUsd <= 0) return true;
    const k = perDollar(price, schedule);
    const cost = centsCeiling(this.size(k.price, schedule).toNumber() * k.loss);
    const spent = centsCeiling(this.seriesLossUsd);
    return Math.round((spent + cost) * 100) <= Math.round(this.maxSeriesLossUsd * 100);
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
    this.baseUsd = this.sizingMode === "fixed" ? Decimal(this.fixedStakes[0]) : Decimal(baseUsd);
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
      fixedStakes: this.fixedStakes.slice(),
      maxStakeUsd: this.maxStakeUsd,
      maxSeriesLossUsd: this.maxSeriesLossUsd,
    });
    const k = perDollar(price, schedule);
    const steps = [];
    let atRiskCents = 0;
    let limitedByBudget = false;
    for (let i = 0; i < this.maxSteps; i += 1) {
      const stake = sim.size(k.price, schedule).toNumber();
      const lossCost = centsCeiling(stake * k.loss);
      const nextAtRiskCents = atRiskCents + Math.round(lossCost * 100);
      if (this.maxSeriesLossUsd > 0 && nextAtRiskCents > Math.round(this.maxSeriesLossUsd * 100)) {
        limitedByBudget = true;
        break;
      }
      steps.push({
        step: i + 1,
        stake: Number(stake.toFixed(2)),
        winNet: Number((stake * k.win - atRiskCents / 100).toFixed(2)),
        capped: sim.isCapped(k.price, schedule),
      });
      atRiskCents = nextAtRiskCents;
      sim.onLoss(lossCost);
    }
    return {
      price: k.price,
      sizingMode: this.sizingMode,
      steps,
      limitedByBudget,
      budgetUsd: this.maxSeriesLossUsd,
      totalAtRisk: Number((atRiskCents / 100).toFixed(2)),
      breakEvenWinRate: Number(breakEvenWinRate(k.price, schedule).toFixed(4)),
    };
  }

  snapshot(price, schedule) {
    return {
      baseUsd: this.baseUsd.toFixed(2),
      step: this.step,
      maxSteps: this.maxSteps,
      sizingMode: this.sizingMode,
      fixedStakes: this.fixedStakes.slice(),
      maxStakeUsd: this.maxStakeUsd,
      maxSeriesLossUsd: this.maxSeriesLossUsd,
      size: this.size(price, schedule).toFixed(2),
      seriesLossUsd: this.seriesLossUsd.toFixed(2),
      consecutiveLosses: this.consecutiveLosses,
      halted: this.halted,
      lotConfirmed: this.lotConfirmed,
    };
  }
}

module.exports = { Risk, SIZING_MODES, perDollar, breakEvenWinRate };
