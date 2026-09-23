"use strict";

/**
 * Polymarket taker fee (docs.polymarket.com/trading/fees):
 *   fee = shares × rate × (p × (1 − p))^exponent, paid in USDC at match time.
 * In V2 it is charged on top of the notional, so it is lost on a win and on a loss.
 * Crypto markets use rate 0.07, exponent 1; makers pay nothing.
 */
const CRYPTO_TAKER_RATE = 0.07;
const DEFAULT_EXPONENT = 1;
// Paper without a live quote prices the round at even odds.
const ASSUMED_PRICE = 0.5;

/** Number or null; null / "" must not silently become 0 (a zero fee rate). */
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validPrice(p) {
  const n = Number(p);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

function takerFee(shares, price, { rate, exponent } = {}) {
  const p = validPrice(price);
  const c = Number(shares);
  if (p == null || !Number.isFinite(c) || c <= 0) return 0;
  const r = num(rate) != null && num(rate) >= 0 ? num(rate) : CRYPTO_TAKER_RATE;
  const e = num(exponent) != null && num(exponent) > 0 ? num(exponent) : DEFAULT_EXPONENT;
  // Polymarket rounds fees to 5 decimals
  return Math.round(c * r * Math.pow(p * (1 - p), e) * 1e5) / 1e5;
}

/** Fee for spending `usd` at `price` (shares = usd / price). */
function takerFeeOnStake(usd, price, schedule) {
  const p = validPrice(price);
  if (p == null) return 0;
  return takerFee(Number(usd) / p, p, schedule);
}

module.exports = { CRYPTO_TAKER_RATE, DEFAULT_EXPONENT, ASSUMED_PRICE, num, validPrice, takerFee, takerFeeOnStake };
