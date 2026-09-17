"use strict";

const { PaperBroker } = require("../paperBroker");
const { PreddyAdapter } = require("../predicAdapter");
const { PolymarketAdapter } = require("./polymarketAdapter");
const { assertVenue } = require("./spi");

/**
 * Factory for the active venue. Engine talks only to the SPI.
 * Auto / live → Polymarket CLOB. Preddy remains a ping-only stub.
 */
function createVenue(kind, options = {}) {
  if (kind === "polymarket" || kind === "auto" || kind === "live") {
    return assertVenue(new PolymarketAdapter(options));
  }
  if (kind === "preddy") {
    return assertVenue(new PreddyAdapter(options));
  }
  return assertVenue(new PaperBroker(options));
}

module.exports = { createVenue };
