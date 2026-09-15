"use strict";

const { PaperBroker } = require("../paperBroker");
const { PreddyAdapter } = require("../predicAdapter");
const { assertVenue } = require("./spi");

/**
 * Factory for the active venue. Add new adapters here (Polymarket, SPI signer, …)
 * without touching Engine.
 */
function createVenue(kind, options = {}) {
  if (kind === "auto" || kind === "preddy" || kind === "live") {
    return assertVenue(new PreddyAdapter(options));
  }
  return assertVenue(new PaperBroker(options));
}

module.exports = { createVenue };
