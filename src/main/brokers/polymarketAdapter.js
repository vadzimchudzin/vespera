"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown, parseList } = require("./polymarketMarkets");
const {
  buildOrder,
  signOrder,
  signClobAuth,
  addressFromPrivateKey,
  signatureTypeFor,
  normalizeWalletType,
  detectWalletType,
} = require("./orderSigner");

const { CRYPTO_TAKER_RATE, DEFAULT_EXPONENT, takerFee } = require("../fees");

const DEFAULT_MIN_SHARES = 5;
const DEFAULT_TICK = 0.01;

function decimalsOf(tick) {
  const s = String(tick);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Filled amount from an order response. The docs describe 6-decimal fixed
 * math, live responses have been seen as plain decimals ("4.999999"), so pick
 * the reading closest to what was sent.
 */
function filledAmount(value, expectedMicro) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (String(value).includes(".")) return n;
  const expected = Number(expectedMicro) / 1e6;
  if (!Number.isFinite(expected) || expected <= 0) return n / 1e6;
  return Math.abs(n - expected) <= Math.abs(n / 1e6 - expected) ? n : n / 1e6;
}

/**
 * Worst price needed to buy `usd` worth from the asks, so a FOK order fills
 * across levels instead of dying on a thin best ask.
 */
function sweepPrice(asks, usd) {
  if (!Array.isArray(asks)) return null;
  const levels = asks
    .map((l) => ({ price: toPrice(l && l.price), size: Number(l && l.size) }))
    .filter((l) => l.price != null && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
  let spent = 0;
  for (const l of levels) {
    spent += l.price * l.size;
    if (spent >= usd) return l.price;
  }
  return null;
}

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
 * Polymarket CLOB V2 venue
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
    this.proxyUrl = options.proxyUrl || "";
    this.symbol = options.symbol || "BTCUSDT";
    this.timeframe = options.timeframe || "15m";
    this.client = options.client || new ClobClient(options);
    this._markets = [];
    this._syncClientIdentity();
  }

  configure(patch = {}) {
    if (patch.apiKey != null) this.apiKey = patch.apiKey;
    if (patch.apiSecret != null) this.apiSecret = patch.apiSecret;
    if (patch.apiPassphrase != null) this.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.walletAddress = patch.walletAddress;
    if (patch.privateKey != null) this.privateKey = patch.privateKey;
    if (patch.walletType != null) this.walletType = patch.walletType;
    if (patch.proxyUrl != null) this.proxyUrl = patch.proxyUrl;
    if (patch.symbol != null) this.symbol = patch.symbol;
    if (patch.timeframe != null) this.timeframe = patch.timeframe;
    if (typeof this.client.configure === "function") this.client.configure(patch);
    this._syncClientIdentity();
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
   * How this account must sign. The exported key signs, but funds may sit in
   * a Deposit Wallet (default since May 2026), a legacy proxy or a Safe.
   */
  resolvedWalletType() {
    const explicit = normalizeWalletType(this.walletType);
    if (explicit) return explicit;
    return detectWalletType(this.signerAddress(), this.walletAddress);
  }

  /** Push the signer identity into the client so L2 headers carry the key's address. */
  _syncClientIdentity() {
    if (typeof this.client.configure !== "function") return;
    const signer = this.signerAddress();
    this.client.configure({
      signerAddress: signer || "",
      signatureType: signer ? signatureTypeFor(this.resolvedWalletType()) : null,
    });
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
        // Separate "cannot reach the host" from "this jurisdiction is blocked",
        // otherwise every failure looks the same in the UI.
        let geo = null;
        if (typeof this.client.geoblock === "function") {
          geo = await this.client.geoblock();
        }
        return {
          ok: false,
          venue: "polymarket",
          status: time.status,
          latencyMs: time.latencyMs,
          message: time.networkError
            ? `network: ${time.networkError}`
            : `http_${time.status}`,
          geo,
          blocked: Boolean(geo && geo.ok && geo.blocked),
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
      let geo = null;
      if (typeof this.client.geoblock === "function") {
        geo = await this.client.geoblock();
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
        geo,
        blocked: Boolean(geo && geo.ok && geo.blocked),
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
      // always 6-decimal micro units; a small balance used to be shown unscaled
      return (n / 1e6).toFixed(2);
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
    let negRisk = false;
    let asks = [];
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
      negRisk = Boolean(book.neg_risk);
      asks = Array.isArray(book.asks) ? book.asks : [];
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
      negRisk,
      asks,
      ...(await this._feeSchedule(resolved.round.conditionId)),
      acceptingOrders: resolved.round.acceptingOrders,
      endDate: resolved.round.endDate,
    };
  }

  /** Fee schedule from /clob-markets (fd: { r, e, to }); crypto defaults when unavailable. */
  async _feeSchedule(conditionId) {
    const fallback = { feeRate: CRYPTO_TAKER_RATE, feeExponent: DEFAULT_EXPONENT };
    if (!conditionId || typeof this.client.clobMarketInfo !== "function") return fallback;
    try {
      const res = await this.client.clobMarketInfo(conditionId);
      if (!res || !res.ok || !res.json) return fallback;
      const fd = res.json.fd;
      if (!fd) return { feeRate: 0, feeExponent: DEFAULT_EXPONENT }; // market without fees
      const r = Number(fd.r);
      const e = Number(fd.e);
      return {
        feeRate: Number.isFinite(r) && r >= 0 ? r : CRYPTO_TAKER_RATE,
        feeExponent: Number.isFinite(e) && e > 0 ? e : DEFAULT_EXPONENT,
      };
    } catch {
      return fallback;
    }
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
    if (quote) {
      // V2 charges the taker fee in USDC on top of the stake: the wallet must hold both.
      const balance = await this.getBalance();
      const need = Number(quote.sizeUsd) + Number(quote.feeUsd || 0);
      if (balance != null && Number.isFinite(Number(balance)) && Number(balance) < need) {
        const err = new Error(`insufficient_balance: $${Number(balance).toFixed(2)} < $${need.toFixed(2)} (stake + fee)`);
        err.code = "insufficient_balance";
        throw err;
      }
    }
    const signerAddress = this.signerAddress();
    const walletType = this.resolvedWalletType();
    this._syncClientIdentity();
    const order = buildOrder({
      tokenId,
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount || "0"),
      // funds live on the wallet address; a Deposit Wallet is also the order signer
      maker: this.walletAddress,
      signer: walletType === "DEPOSIT_WALLET" ? this.walletAddress : signerAddress || this.walletAddress,
      side,
      signatureType: signatureTypeFor(walletType),
    });
    const signed = await signOrder(order, this.privateKey, { negRisk: Boolean(quote && quote.negRisk) });
    const res = await this.client.postOrder(signed);
    if (!res.ok) {
      const detail = (res.json && res.json.errorMsg) || (res.json && res.json.error) || res.raw || "";
      const err = new Error(`clob_order_rejected: ${res.status}${detail ? ` ${detail}` : ""}`);
      err.code = "clob_order_rejected";
      err.response = res;
      throw err;
    }
    // Book what actually filled (price improvement gives more shares than asked).
    const spent = filledAmount(res.json && res.json.makingAmount, makerAmount);
    const got = filledAmount(res.json && res.json.takingAmount, takerAmount);
    let fill = null;
    if (quote && spent && got) {
      const avg = spent / got;
      fill = {
        sizeUsd: spent.toFixed(2),
        shares: Number(got.toFixed(4)),
        price: Number(avg.toFixed(5)),
        payout: got / spent,
        feeUsd: takerFee(got, avg, { rate: quote.feeRate, exponent: quote.feeExponent }).toFixed(5),
      };
    }
    const booked = fill || quote;
    return {
      ok: true,
      accepted: true,
      venue: "polymarket",
      orderId: (res.json && (res.json.orderID || res.json.orderId)) || null,
      orderStatus: (res.json && res.json.status) || null,
      walletType,
      tokenId,
      clientOrderId: params.clientOrderId || null,
      side: quote ? quote.side : side === 1 ? "DOWN" : "UP",
      sizeUsd: booked ? booked.sizeUsd : null,
      price: booked ? booked.price : null,
      limitPrice: quote ? quote.price : null,
      shares: booked ? booked.shares : null,
      payout: booked ? booked.payout : null,
      feeUsd: booked ? booked.feeUsd : null,
      filled: Boolean(fill),
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
    // Marketable BUY precision the CLOB enforces: USD (maker) to 2 decimals,
    // shares (taker) to 4 decimals, price on the market tick.
    const tick = Number(quote.tickSize) > 0 ? Number(quote.tickSize) : DEFAULT_TICK;
    const priceDp = decimalsOf(tick);
    const swept = sweepPrice(quote.asks, usd);
    const limit = Math.min(1 - tick, Math.max(quote.price, swept || 0));
    const price = Number((Math.ceil(limit / tick - 1e-9) * tick).toFixed(priceDp));
    const makerMicro = Math.floor(usd * 100 + 1e-9) * 10_000;
    const takerMicro = Math.floor(makerMicro / price / 100 + 1e-9) * 100;
    const shares = takerMicro / 1e6;
    if (shares < quote.minOrderSize) {
      const minUsd = Math.ceil(quote.minOrderSize * price * 100) / 100;
      const err = new Error(
        `below_min_size: ${shares.toFixed(2)} shares < ${quote.minOrderSize} (raise the lot to at least $${minUsd.toFixed(2)})`
      );
      err.code = "below_min_size";
      err.minSizeUsd = minUsd;
      throw err;
    }
    const schedule = { rate: quote.feeRate, exponent: quote.feeExponent };
    const feeUsd = takerFee(shares, price, schedule);
    return {
      tokenId: quote.tokenId,
      makerAmount: String(makerMicro),
      takerAmount: String(takerMicro),
      side: 0, // BUY
      quote: {
        ...quote,
        asks: undefined,
        price,
        payout: shares / (makerMicro / 1e6),
        sizeUsd: (makerMicro / 1e6).toFixed(2),
        shares,
        feeUsd: feeUsd.toFixed(5),
      },
    };
  }

  /**
   * Final result of a round as Polymarket resolved it (Chainlink TWAP),
   * read from Gamma's outcomePrices once the market is closed.
   */
  async resolvedOutcome(slug) {
    if (!slug || typeof this.client.eventBySlug !== "function") return { resolved: false };
    const res = await this.client.eventBySlug(slug);
    if (!res || !res.ok || !res.json) return { resolved: false };
    const market = Array.isArray(res.json.markets) && res.json.markets[0] ? res.json.markets[0] : res.json;
    if (!market.closed) return { resolved: false };
    const outcomes = parseList(market.outcomes).map((o) => String(o).toLowerCase());
    const prices = parseList(market.outcomePrices).map(Number);
    const winner = prices.findIndex((p) => p >= 0.99);
    if (winner < 0 || !outcomes[winner]) return { resolved: false };
    const name = outcomes[winner];
    const outcome = name === "up" || name === "yes" ? "UP" : name === "down" || name === "no" ? "DOWN" : null;
    return outcome ? { resolved: true, outcome } : { resolved: false };
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
