"use strict";

function fromCents(cents) {
  return Decimal(cents / 100);
}

function Decimal(value) {
  if (value && typeof value === "object" && Number.isInteger(value.cents)) {
    return value;
  }
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid money: ${value}`);
  }
  const cents = Math.round(n * 100);
  return {
    cents,
    toNumber() {
      return cents / 100;
    },
    toFixed(digits = 2) {
      return (cents / 100).toFixed(digits);
    },
    add(other) {
      return fromCents(cents + Decimal(other).cents);
    },
    sub(other) {
      return fromCents(cents - Decimal(other).cents);
    },
    mul(factor) {
      return fromCents(Math.round(cents * Number(factor)));
    },
    gte(other) {
      return cents >= Decimal(other).cents;
    },
    gt(other) {
      return cents > Decimal(other).cents;
    },
  };
}

module.exports = { Decimal };
