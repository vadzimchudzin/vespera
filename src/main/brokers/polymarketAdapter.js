"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown } = require("./polymarketMarkets");
const {
  buildOrder,
  signOrder,
  signClobAuth,
  addressFromPrivateKey,
  signatureTypeFor,
} = require("./orderSigner");

const DEFAULT_MIN_SHARES = 5;
const DEFAULT_TICK = 0.01;

function toPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

/** Book asks come back descending; the best ask is the lowest price. */
function bestAsk(asks) {
  if (!Array.isArray(asks) || !asks.length) return null;
  let best = null;
  for (const level of asks) {
    const p = toPrice(level && level.price);
    if (p != null && (best == null || p < best)) best = p;
  }
  return best;
}

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
    this.walletType = options.walletType || "AUTO";
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
    if (patch.walletType != null) this.walletType = patch.walletType;
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

  /** Address of the signing key, or null when no key is set. */
  signerAddress() {
    if (!this.privateKey) return null;
    try {
      return addressFromPrivateKey(this.privateKey);
    } catch {
      return null;
    }
  }

  /**
   * How this account must sign. Email / Google accounts keep funds in a proxy
   * wallet, so the wallet address differs from the signing key's address and
   * the order has to be POLY_PROXY, not EOA.
   */
  resolvedWalletType() {
    const explicit = String(this.walletType || "AUTO").toUpperCase();
    if (explicit !== "AUTO") return explicit;
    const signer = this.signerAddress();
    if (!signer || !this.walletAddress) return "EOA";
    return signer.toLowerCase() === String(this.walletAddress).toLowerCase() ? "EOA" : "POLY_PROXY";
  }

  /**
   * Fetch the L2 credentials (apiKey / secret / passphrase) from the CLOB
   * using the signing key. Polymarket does not expose these in its web UI.
   */
  async deriveCredentials() {
    if (!this.hasPrivateKey()) {
      return { ok: false, reason: "missing_private_key" };
    }
    if (typeof this.client.deriveApiKey !== "function") {
      return { ok: false, reason: "unsupported_client" };
    }
    let auth;
    try {
      auth = await signClobAuth(this.privateKey, { timestamp: Math.floor(Date.now() / 1000), nonce: 0 });
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
    const res = await this.client.deriveApiKey(auth);
    if (!res.ok) {
      return { ok: false, reason: res.message || "derive_failed", status: res.status };
    }
    this.apiKey = res.apiKey;
    this.apiSecret = res.secret;
    this.apiPassphrase = res.passphrase;
    if (typeof this.client.configure === "function") {
      this.client.configure({
        apiKey: res.apiKey,
        apiSecret: res.secret,
        apiPassphrase: res.passphrase,
      });
    }
    return {
      ok: true,
      apiKey: res.apiKey,
      apiSecret: res.secret,
      apiPassphrase: res.passphrase,
      signerAddress: auth.address,
      walletType: this.resolvedWalletType(),
    };
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
      // Live book prices for the current round, so the UI can show the real
      // payout instead of implying a flat x2.
      let quotes = null;
      if (market.ok) {
        const [up, down] = await Promise.all([
          this.getQuote({ side: "UP", tsMs: Date.now() }),
          this.getQuote({ side: "DOWN", tsMs: Date.now() }),
        ]);
        quotes = {
          UP: up.ok ? { price: up.price, payout: up.payout } : null,
          DOWN: down.ok ? { price: down.price, payout: down.payout } : null,
          minOrderSize: up.ok ? up.minOrderSize : down.ok ? down.minOrderSize : null,
        };
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
        reason: market.ok ? null : market.reason || null,
        quotes,
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

  async loadMarkets(opts = {}) {
    try {
      const res = await this.client.fetchActiveMarkets(opts);
      this._markets = res.markets || [];
      return this._markets;
    } catch {
      return [];
    }
  }

  /**
   * Live quote for one side of the current round.
   *
   * Polymarket pays $1 per winning share, so the payout multiple is 1/price,
   * NOT a flat x2. At an ask of 0.70 a $1 stake returns $1.43, not $2.
   */
  async getQuote({ side = "UP", tsMs } = {}) {
    const wanted = side === "DOWN" || side === 1 ? "DOWN" : "UP";
    const resolved = await this.resolveRound(tsMs == null ? Date.now() : tsMs);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, slug: resolved.slug || null, side: wanted };
    }
    const tokenId = resolved.round.tokens[wanted];
    if (!tokenId) {
      return { ok: false, reason: "tokens_missing", slug: resolved.slug, side: wanted };
    }
    let ask = null;
    let mid = null;
    let minOrderSize = DEFAULT_MIN_SHARES;
    let tickSize = DEFAULT_TICK;
    try {
      const [priceRes, midRes, bookRes] = await Promise.all([
        this.client.price(tokenId, "buy"),
        this.client.midpoint(tokenId),
        this.client.getOrderBook(tokenId),
      ]);
      ask = toPrice(priceRes && priceRes.json && priceRes.json.price);
      mid = toPrice(midRes && midRes.json && midRes.json.mid);
      const book = (bookRes && bookRes.json) || {};
      if (Number(book.min_order_size) > 0) minOrderSize = Number(book.min_order_size);
      if (Number(book.tick_size) > 0) tickSize = Number(book.tick_size);
      if (ask == null) ask = bestAsk(book.asks);
    } catch (err) {
      return { ok: false, reason: String(err.message || err), slug: resolved.slug, side: wanted };
    }
    const price = ask != null ? ask : mid;
    if (price == null || price <= 0 || price >= 1) {
      return { ok: false, reason: "no_quote", slug: resolved.slug, side: wanted, tokenId };
    }
    return {
      ok: true,
      side: wanted,
      tokenId,
      slug: resolved.slug,
      price,
      mid,
      payout: 1 / price,
      minOrderSize,
      tickSize,
      acceptingOrders: resolved.round.acceptingOrders,
      endDate: resolved.round.endDate,
    };
  }

  /**
   * Execute a live market order on Polymarket CLOB via EIP-712.
   * Requires hasL2() && hasPrivateKey().
   *
   * Two shapes are accepted:
   *  - raw:    { tokenId, makerAmount, takerAmount, side }
   *  - engine: { side: "UP"|"DOWN", sizeUsd, clientOrderId, round }
   * The engine shape resolves the round, prices the book and sizes the order.
   */
  async marketBuy(params = {}) {
    if (!this.hasL2() || !this.hasPrivateKey()) {
      // Keep error code as auto_not_wired for backward compat with tests
      const err = new Error("auto_not_wired");
      err.code = "auto_not_wired";
      throw err;
    }
    const resolved = params.tokenId && params.makerAmount != null
      ? { tokenId: params.tokenId, makerAmount: params.makerAmount, takerAmount: params.takerAmount, side: params.side, quote: null }
      : await this._sizeFromSignal(params);
    const { tokenId, makerAmount, takerAmount, quote } = resolved;
    const side = typeof resolved.side === "number" ? resolved.side : 0;
    if (!tokenId) {
      const err = new Error("missing_tokenId");
      err.code = "missing_tokenId";
      throw err;
    }
    const signerAddress = this.signerAddress();
    const walletType = this.resolvedWalletType();
    const order = buildOrder({
      tokenId,
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount || "0"),
      // funds live on the wallet address, the exported key only signs
      maker: this.walletAddress,
      signer: signerAddress || this.walletAddress,
      side,
      signatureType: signatureTypeFor(walletType),
    });
    const signed = await signOrder(order, this.privateKey);
    const res = await this.client.postOrder(signed, this.walletAddress);
    if (!res.ok) {
      const err = new Error(`clob_order_rejected: ${res.status}`);
      err.code = "clob_order_rejected";
      err.response = res;
      throw err;
    }
    return {
      ok: true,
      accepted: true,
      venue: "polymarket",
      orderId: (res.json && (res.json.orderID || res.json.orderId)) || null,
      tokenId,
      clientOrderId: params.clientOrderId || null,
      side: quote ? quote.side : side === 1 ? "DOWN" : "UP",
      sizeUsd: quote ? quote.sizeUsd : null,
      price: quote ? quote.price : null,
      shares: quote ? quote.shares : null,
      payout: quote ? quote.payout : null,
      slug: quote ? quote.slug : null,
      strike: params.round ? params.round.strike : null,
      roundOpenTs: params.round ? params.round.openTs : null,
      roundCloseTs: params.round ? params.round.closeTs : null,
      order: signed.order,
      signature: signed.signature,
      response: res.json,
    };
  }

  /**
   * Turn an engine signal into a priced, size-checked CLOB order.
   * Amounts are USDC micro-units (6 decimals).
   */
  async _sizeFromSignal({ side = "UP", sizeUsd, round } = {}) {
    const quote = await this.getQuote({
      side,
      tsMs: round && round.openTs ? round.openTs : Date.now(),
    });
    if (!quote.ok) {
      const err = new Error(quote.reason || "no_quote");
      err.code = quote.reason || "no_quote";
      throw err;
    }
    if (quote.acceptingOrders === false) {
      const err = new Error("round_closed");
      err.code = "round_closed";
      throw err;
    }
    const usd = Number(sizeUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      const err = new Error("bad_size");
      err.code = "bad_size";
      throw err;
    }
    const makerMicro = Math.round(usd * 1e6);
    const takerMicro = Math.floor(makerMicro / quote.price);
    const shares = takerMicro / 1e6;
    if (shares < quote.minOrderSize) {
      const err = new Error(
        `below_min_size: ${shares.toFixed(2)} shares < ${quote.minOrderSize} (raise the lot to at least $${(quote.minOrderSize * quote.price).toFixed(2)})`
      );
      err.code = "below_min_size";
      err.minSizeUsd = Number((quote.minOrderSize * quote.price).toFixed(2));
      throw err;
    }
    return {
      tokenId: quote.tokenId,
      makerAmount: String(makerMicro),
      takerAmount: String(takerMicro),
      side: 0, // BUY
      quote: { ...quote, sizeUsd: usd.toFixed(2), shares: Number(shares.toFixed(4)) },
    };
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
