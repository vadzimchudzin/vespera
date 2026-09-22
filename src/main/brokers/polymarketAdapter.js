"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown } = require("./polymarketMarkets");
const { buildOrder, signOrder } = require("./orderSigner");

/**
 * Polymarket CLOB venue — v0.9.0
 *
 * Supports:
 *  - Public ping + Gamma Up/Down resolve
 *  - L2 balance read (apiKey/secret/passphrase + wallet)
 *  - Live marketBuy via EIP-712 order signing (requires privateKey)
 *  - loadMarkets() via Gamma active-market feed
 */
class PolymarketAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.apiSecret = options.apiSecret || "";
    this.apiPassphrase = options.apiPassphrase || "";
    this.walletAddress = options.walletAddress || "";
    this.privateKey = options.privateKey || "";
    this.symbol = options.symbol || "BTCUSDT";
    this.timeframe = options.timeframe || "15m";
    this.client = options.client || new ClobClient(options);
    this._markets = [];
  }

  configure(patch = {}) {
    if (patch.apiKey != null) this.apiKey = patch.apiKey;
    if (patch.apiSecret != null) this.apiSecret = patch.apiSecret;
    if (patch.apiPassphrase != null) this.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.walletAddress = patch.walletAddress;
    if (patch.privateKey != null) this.privateKey = patch.privateKey;
    if (patch.symbol != null) this.symbol = patch.symbol;
    if (patch.timeframe != null) this.timeframe = patch.timeframe;
    if (typeof this.client.configure === "function") this.client.configure(patch);
    return this;
  }

  hasL2() {
    return Boolean(this.apiKey && this.apiSecret && this.apiPassphrase && this.walletAddress);
  }

  hasPrivateKey() {
    return Boolean(this.privateKey);
  }

  // ── public methods ────────────────────────────────────────────────────────

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
      const hasSigner = this.hasL2() && this.hasPrivateKey();
      return {
        ok: true,
        venue: "polymarket",
        latencyMs: time.latencyMs,
        status: time.status,
        message: l2Ok === false ? "l2_failed" : market.ok ? "reachable" : market.reason || "reachable",
        trading: hasSigner,
        hasKey: Boolean(this.apiKey),
        hasSigner,
        hasPrivKey: this.hasPrivateKey(),
        l2Ok,
        slug: market.slug,
        market: market.ok ? market.round : null,
        l2,
        note: hasSigner
          ? "CLOB live trading enabled (EIP-712 signer ready)."
          : this.hasL2()
          ? "CLOB L2 present. Add privateKey to enable live marketBuy."
          : "CLOB ping is public. Paste apiKey, secret, passphrase, wallet and privateKey to enable live trading.",
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

  /**
   * Fetch active Polymarket markets from Gamma API.
   * @param {object} [opts]
   * @param {string[]} [opts.timeframes]
   * @returns {Promise<Array>} mapped market list
   */
  async loadMarkets(opts = {}) {
    try {
      const res = await this.client.fetchActiveMarkets(opts);
      this._markets = res.markets || [];
      return this._markets;
    } catch (err) {
      return [];
    }
  }

  /**
   * Execute a live market order on Polymarket CLOB via EIP-712.
   * Requires hasL2() && hasPrivateKey().
   *
   * @param {object} params
   * @param {string} params.tokenId     - YES token ID to buy
   * @param {string} params.makerAmount - USDC amount (6-decimal string, e.g. "5000000" = $5)
   * @param {string} params.takerAmount - minimum outcome tokens
   * @param {string} [params.side]      - "UP"|"DOWN" or 0|1 (0=BUY)
   */
  async marketBuy({ tokenId, makerAmount, takerAmount, side = 0 } = {}) {
    if (!this.hasL2() || !this.hasPrivateKey()) {
      const err = new Error("live_not_configured");
      err.code = "live_not_configured";
      throw err;
    }
    if (!tokenId) {
      const err = new Error("missing_tokenId");
      err.code = "missing_tokenId";
      throw err;
    }
    const order = buildOrder({
      tokenId,
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount || "0"),
      maker: this.walletAddress,
      side: typeof side === "number" ? side : 0,
    });
    const signed = await signOrder(order, this.privateKey);
    const res = await this.client.postOrder(signed, this.walletAddress);
    if (!res.ok) {
      const err = new Error(`clob_order_rejected: ${res.status}`);
      err.code = "clob_order_rejected";
      err.response = res;
      throw err;
    }
    return { ok: true, order: signed.order, signature: signed.signature, response: res.json };
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
