"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown } = require("./polymarketMarkets");

/**
 * Polymarket CLOB venue.
 *
 * Public ping + Gamma Up/Down resolve are live.
 * marketBuy stays blocked until an L1/L2 signer is wired.
 */
class PolymarketAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.apiSecret = options.apiSecret || "";
    this.apiPassphrase = options.apiPassphrase || "";
    this.walletAddress = options.walletAddress || "";
    this.symbol = options.symbol || "BTCUSDT";
    this.timeframe = options.timeframe || "15m";
    this.client = options.client || new ClobClient(options);
  }

  configure(patch = {}) {
    if (patch.apiKey != null) this.apiKey = patch.apiKey;
    if (patch.apiSecret != null) this.apiSecret = patch.apiSecret;
    if (patch.apiPassphrase != null) this.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.walletAddress = patch.walletAddress;
    if (patch.symbol != null) this.symbol = patch.symbol;
    if (patch.timeframe != null) this.timeframe = patch.timeframe;
    return this;
  }

  hasL2() {
    return Boolean(this.apiKey && this.apiSecret && this.apiPassphrase && this.walletAddress);
  }

  async ping() {
    try {
      const time = await this.client.time();
      if (!time.ok) {
        return {
          ok: false,
          venue: "polymarket",
          status: time.status,
          latencyMs: time.latencyMs,
          message: `http_${time.status}`,
          trading: false,
        };
      }
      return {
        ok: true,
        venue: "polymarket",
        latencyMs: time.latencyMs,
        status: time.status,
        message: "reachable",
        trading: false,
        hasKey: Boolean(this.apiKey),
        hasSigner: this.hasL2(),
        note: "CLOB ping is public. Live orders wait for an L1/L2 signer.",
      };
    } catch (err) {
      return { ok: false, venue: "polymarket", message: String(err.message || err), trading: false };
    }
  }

  async getBalance() {
    if (!this.hasL2()) return null;
    return null;
  }

  async marketBuy() {
    const err = new Error("auto_not_wired");
    err.code = "auto_not_wired";
    throw err;
  }

  async resolveRound(tsMs) {
    return resolveUpDown(this.client, {
      symbol: this.symbol,
      timeframe: this.timeframe,
      tsMs,
    });
  }
}

module.exports = { PolymarketAdapter };
