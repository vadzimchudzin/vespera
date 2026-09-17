"use strict";

/**
 * Strategy catalog.
 * Add a new strategy: implement evaluate(bars, index, options) -> { signal, reason, ... }
 * and register it here. Engine + UI read this list — no other wiring.
 */

const { evaluateBar } = require("../strategy");

function catalog() {
  return [
    {
      id: "sma200_20",
      name: "SMA200/20",
      description: "SMA200 trend, S-1 body beyond SMA20, S full body of the needed color beyond SMA20, bet on S+1",
      enabled: true,
      evaluate(bars, index, options) {
        return evaluateBar(bars, index, options);
      },
    },
  ];
}

function getStrategy(id) {
  const list = catalog();
  return list.find((s) => s.id === id) || list[0];
}

function listStrategies() {
  return catalog().map(({ id, name, description, enabled }) => ({
    id,
    name,
    description,
    enabled: enabled !== false,
  }));
}

module.exports = {
  catalog,
  getStrategy,
  listStrategies,
  DEFAULT_STRATEGY_ID: "sma200_20",
};
