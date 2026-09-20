"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown } = require("./polymarketMarkets");

/**
 * Polymarket CLOB venue.
 *
 * Public ping + Gamma Up/Down resolve are live.
 * L2 (apiKey/secret/passphrase + wallet) reads collateral.
 * marketBuy stays blocked until an EIP-712 order signer is wired.
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
    if (typeof this.client.configure === "function") this.client.configure(patch);
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
      const market = await resolveUpDown(this.client, {
        symbol: this.symbol,
        timeframe: this.timeframe,
        tsMs: Date.now(),
      });
      let l2 = null;
      if (this.hasL2() && typeof this.client.balanceAllowance === "function") {
        try {
          const bal = await this.client.balanceAllowance();
          l2 = { ok: bal.ok, status: bal.status };
        } catch (err) {
          l2 = { ok: false, message: String(err.message || err) };
        }
      }
      const l2Ok = l2 ? Boolean(l2.ok) : null;
      return {
        ok: true,
        venue: "polymarket",
        latencyMs: time.latencyMs,
        status: time.status,
        message: l2Ok === false ? "l2_failed" : market.ok ? "reachable" : market.reason || "reachable",
        trading: false,
        hasKey: Boolean(this.apiKey),
        hasSigner: this.hasL2(),
        l2Ok,
        slug: market.slug,
        market: market.ok ? market.round : null,
        l2,
        note: this.hasL2()
          ? l2Ok === false
            ? "CLOB reachable, but these L2 credentials were rejected."
            : "CLOB L2 present. Live marketBuy waits for an EIP-712 signer."
          : "CLOB ping is public. Paste apiKey, secret, passphrase and wallet to enable L2.",
      };
    } catch (err) {
      return { ok: false, venue: "polymarket", message: String(err.message || err), trading: false };
    }
  }

  async getBalance() {
    if (!this.hasL2() || typeof this.client.balanceAllowance !== "function") return null;
    try {
      const res = await this.client.balanceAllowance();
      if (!res.ok || !res.json) return null;
      const raw = res.json.balance ?? res.json.collateral ?? res.json.amount;
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return String(raw);
      return n > 1e4 ? (n / 1e6).toFixed(2) : n.toFixed(2);
    } catch {
      return null;
    }
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
