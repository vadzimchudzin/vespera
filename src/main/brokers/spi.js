"use strict";

/**
 * Venue SPI — every live/paper book implements this shape.
 *
 * ping()            -> { ok, venue, latencyMs?, message?, trading? }
 * getBalance()      -> string USD or null
 * marketBuy(order)  -> fill { side, sizeUsd, feeUsd, strike, roundOpenTs, roundCloseTs, ... }
 * settle(bar)       -> settled | null   (paper only; live books settle on the venue)
 *
 * Engine talks only to this surface. Preddy / Polymarket / SPI adapters plug in here.
 */

class VenueError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function assertVenue(venue) {
  if (!venue || typeof venue.ping !== "function" || typeof venue.marketBuy !== "function") {
    throw new VenueError("invalid_venue", "Venue must implement ping() and marketBuy()");
  }
  return venue;
}

module.exports = { VenueError, assertVenue };
