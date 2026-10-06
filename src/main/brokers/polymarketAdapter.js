"use strict";

const { ClobClient } = require("./clobClient");
const { resolveUpDown, parseList } = require("./polymarketMarkets");
const {
  buildOrder,
  signOrder,
  orderHash,
  signClobAuth,
  addressFromPrivateKey,
  signatureTypeFor,
  normalizeWalletType,
  detectWalletType,
  EXCHANGE_ADDRESS,
  NEG_RISK_EXCHANGE_ADDRESS,
} = require("./orderSigner");

const { CRYPTO_TAKER_RATE, DEFAULT_EXPONENT, takerFee } = require("../fees");

const DEFAULT_MIN_SHARES = 5;
const DEFAULT_TICK = 0.01;
// Worst price a buy may pay above the book at quote time; fills still happen
// at the resting asks, this only widens the ceiling.
const DEFAULT_SLIPPAGE = 0.02;
// Fill-and-kill, as Polymarket's own client defaults to. A FOK must spend the
// USD amount to the micro-cent, which fails whenever the fill price does not
// divide the stake evenly ($5 / 0.54 = 9.259259… shares) and the CLOB kills
// the whole order. FAK fills what matches and drops the dust.
const ORDER_TYPE = "FAK";
// Zero-fill outcomes: nothing matched, so a retry cannot double the position.
const NOTHING_FILLED = /couldn't be fully filled|fully filled or killed|no orders found to match|no match|not enough liquidity/i;

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
    this.slippage = Number.isFinite(Number(options.slippage)) ? Number(options.slippage) : DEFAULT_SLIPPAGE;
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
    if (patch.slippage != null && Number.isFinite(Number(patch.slippage))) this.slippage = Number(patch.slippage);
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

  /** What the addresses imply, or null until both the key and the wallet are known. */
  detectedWalletType() {
    const signer = this.signerAddress();
    if (!signer || !this.walletAddress) return null;
    return detectWalletType(signer, this.walletAddress);
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
        this.client.price(tokenId, "sell"), // "sell" = best ask, see ClobClient.price
        this.client.midpoint(tokenId),
        this.client.getOrderBook(tokenId),
      ]);
      mid = toPrice(midRes && midRes.json && midRes.json.mid);
      const book = (bookRes && bookRes.json) || {};
      if (Number(book.min_order_size) > 0) minOrderSize = Number(book.min_order_size);
      if (Number(book.tick_size) > 0) tickSize = Number(book.tick_size);
      negRisk = Boolean(book.neg_risk);
      asks = Array.isArray(book.asks) ? book.asks : [];
      ask = bestAsk(book.asks);
      if (ask == null) ask = toPrice(priceRes && priceRes.json && priceRes.json.price);
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
  /**
   * pUSD balance and exchange allowances as the CLOB sees them
   * (GET /balance-allowance → { balance, allowances: { spender: amount } }).
   * An allowance of 0 for the V2 exchange means every order will be refused
   * with "not enough balance / allowance".
   */
  async account() {
    if (!this.hasL2() || typeof this.client.balanceAllowance !== "function") {
      return { ok: false, reason: "missing_l2" };
    }
    let res;
    try {
      res = await this.client.balanceAllowance();
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
    if (!res || !res.ok || !res.json) {
      return { ok: false, status: res && res.status, reason: (res && (res.raw || `http_${res.status}`)) || "no_response" };
    }
    const raw = Number(res.json.balance ?? res.json.collateral ?? 0);
    const allowances = res.json.allowances && typeof res.json.allowances === "object" ? res.json.allowances : null;
    const read = (addr) => {
      if (!allowances) return null;
      const hit = Object.keys(allowances).find((k) => k.toLowerCase() === addr.toLowerCase());
      if (!hit) return null;
      // values are uint256 strings, often 2^256−1; only zero vs non-zero matters
      return /^0*$/.test(String(allowances[hit]).replace(/\D/g, "")) ? "zero" : "set";
    };
    const single = res.json.allowance != null ? (Number(res.json.allowance) > 0 ? "set" : "zero") : null;
    return {
      ok: true,
      balanceUsd: Number.isFinite(raw) ? raw / 1e6 : null,
      exchange: read(EXCHANGE_ADDRESS) || single,
      negRiskExchange: read(NEG_RISK_EXCHANGE_ADDRESS),
    };
  }

  /** Cheap reachability check for the Auto watchdog: CLOB /time, plus geoblock on failure. */
  async health() {
    try {
      const res = await this.client.time();
      if (res && res.ok) return { ok: true, latencyMs: res.latencyMs };
      let geo = null;
      if (typeof this.client.geoblock === "function") geo = await this.client.geoblock();
      const blocked = Boolean(geo && geo.ok && geo.blocked);
      return {
        ok: false,
        code: blocked ? "geoblocked" : (res && res.errorCode) || null,
        reason: blocked ? `geoblocked${geo.country ? ` ${geo.country}` : ""}` : (res && (res.networkError || `http_${res.status}`)) || "unreachable",
      };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  /**
   * Whether Polymarket accepts orders from the current IP (or the proxy's).
   * A blocked region still answers /time, quotes, balances and key derivation;
   * only POST /order is refused with 403, so reachability alone proves nothing.
   */
  async region({ maxAgeMs = 60_000 } = {}) {
    if (typeof this.client.geoblock !== "function") return { ok: false, reason: "unsupported" };
    const key = this.proxyUrl || "";
    if (this._region && this._region.key === key && Date.now() - this._region.at < maxAgeMs) return this._region.value;
    let value;
    try {
      value = await this.client.geoblock();
    } catch (err) {
      value = { ok: false, reason: String((err && err.message) || err) };
    }
    if (value && value.ok) this._region = { key, at: Date.now(), value };
    return value || { ok: false, reason: "no_response" };
  }

  async marketBuy(params = {}) {
    // Dry run signs with the real key and checks the real balance, but never posts.
    const dryRun = Boolean(params.dryRun);
    if (dryRun && !this.hasPrivateKey()) {
      const err = new Error("auto_not_wired: dry run needs the private key");
      err.code = "auto_not_wired";
      throw err;
    }
    if (!dryRun && (!this.hasL2() || !this.hasPrivateKey())) {
      // Keep error code as auto_not_wired for backward compat with tests
      const err = new Error("auto_not_wired");
      err.code = "auto_not_wired";
      throw err;
    }
    const resolved = params.tokenId && params.makerAmount != null
      ? { tokenId: params.tokenId, makerAmount: params.makerAmount, takerAmount: params.takerAmount, side: params.side, quote: null }
      : await this._sizeFromSignal(params);
    const { tokenId, makerAmount, takerAmount, quote } = resolved;
    if (quote && Number.isFinite(params.maxTotalCostUsd)) {
      const cost = Math.ceil((Number(quote.sizeUsd) + Number(quote.feeUsd || 0)) * 100 - 1e-9) / 100;
      if (cost > params.maxTotalCostUsd + 1e-9) {
        const err = new Error("budget_exceeded: stake and fee exceed the remaining budget");
        err.code = "budget_exceeded";
        throw err;
      }
    }
    const side = typeof resolved.side === "number" ? resolved.side : 0;
    if (!tokenId) {
      const err = new Error("missing_tokenId");
      err.code = "missing_tokenId";
      throw err;
    }
    if (quote && this.hasL2()) {
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
    if (dryRun) {
      return {
        ok: true,
        accepted: true,
        dryRun: true,
        venue: "polymarket",
        orderId: null,
        orderStatus: "dry_run",
        walletType,
        tokenId,
        clientOrderId: params.clientOrderId || null,
        side: quote ? quote.side : side === 1 ? "DOWN" : "UP",
        sizeUsd: quote ? quote.sizeUsd : null,
        price: quote ? quote.price : null,
        limitPrice: quote ? quote.limitPrice : null,
        shares: quote ? quote.shares : null,
        payout: quote ? quote.payout : null,
        feeUsd: quote ? quote.feeUsd : null,
        filled: false,
        slug: quote ? quote.slug : null,
        strike: params.round ? params.round.strike : null,
        roundOpenTs: params.round ? params.round.openTs : null,
        roundCloseTs: params.round ? params.round.closeTs : null,
        order: signed.order,
        signature: signed.signature,
        balanceChecked: this.hasL2(),
      };
    }
    if (params.isActive && !params.isActive()) {
      const err = new Error("execution_changed: entry cancelled before submission");
      err.code = "execution_changed";
      throw err;
    }
    let res;
    if (typeof params.onPrepared === "function") {
      await params.onPrepared({
        orderId: orderHash(order, { negRisk: Boolean(quote && quote.negRisk) }),
        maker: order.maker, tokenId: String(tokenId), side: params.side,
        slug: quote?.slug || null, sizeUsd: quote?.sizeUsd || (Number(makerAmount) / 1e6).toFixed(6),
        limitPrice: quote?.limitPrice || Number(makerAmount) / Number(takerAmount),
        feeRate: quote?.feeRate, feeExponent: quote?.feeExponent,
      });
    }
    if (params.isActive && !params.isActive()) {
      const err = new Error("execution_changed: entry cancelled before submission");
      err.code = "execution_changed";
      throw err;
    }
    try {
      res = await this.client.postOrder({ ...signed, orderType: ORDER_TYPE });
    } catch (cause) {
      const err = new Error(`order_outcome_unknown: ${String(cause.message || cause)}`);
      err.code = "order_outcome_unknown";
      err.ambiguous = true;
      throw err;
    }
    if (!res || res.status === 0 || res.status >= 500 || (res.ok && (!res.json || res.json.success === false))) {
      const err = new Error("order_outcome_unknown: no reliable execution response");
      err.code = "order_outcome_unknown";
      err.ambiguous = true;
      throw err;
    }
    if (!res.ok) {
      const detail = (res.json && res.json.errorMsg) || (res.json && res.json.error) || res.raw || "";
      if (res.status === 403 && /restricted in your region|geoblock/i.test(String(detail))) {
        this._region = null;
        const err = new Error(`geoblocked: ${detail}`);
        err.code = "geoblocked";
        err.response = res;
        throw err;
      }
      if (NOTHING_FILLED.test(String(detail)) && quote && !params.fokRetried) {
        return this.marketBuy({ ...params, fokRetried: true, slippage: 2 * this.slippage });
      }
      const err = new Error(`clob_order_rejected: ${res.status}${detail ? ` ${detail}` : ""}`);
      err.code = "clob_order_rejected";
      err.networkCode = res.errorCode || null;
      err.response = res;
      throw err;
    }
    // Book what actually filled (price improvement gives more shares than asked).
    const spent = filledAmount(res.json && res.json.makingAmount, makerAmount);
    const got = filledAmount(res.json && res.json.takingAmount, takerAmount);
    if (quote && (!spent || !got || spent > Number(quote.sizeUsd) + 1e-6 || spent / got > Number(quote.limitPrice) + 1e-6 || !(spent / got > 0 && spent / got < 1))) {
      const err = new Error("order_outcome_unknown: fill amounts are missing or inconsistent");
      err.code = "order_outcome_unknown";
      err.ambiguous = true;
      throw err;
    }
    let fill = null;
    if (quote && spent && got) {
      const avg = spent / got;
      fill = {
        sizeUsd: spent.toFixed(6),
        shares: got,
        price: Number(avg.toFixed(5)),
        payout: got / spent,
        feeUsd: takerFee(got, avg, { rate: quote.feeRate, exponent: quote.feeExponent }).toFixed(5),
      };
    }
    const booked = fill || quote;
    const partial = Boolean(fill && quote && spent < Number(quote.sizeUsd) * 0.95);
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
      limitPrice: quote ? quote.limitPrice : null,
      shares: booked ? booked.shares : null,
      payout: booked ? booked.payout : null,
      feeUsd: booked ? booked.feeUsd : null,
      filled: Boolean(fill),
      fokRetried: Boolean(params.fokRetried),
      partial,
      orderType: ORDER_TYPE,
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
  async _sizeFromSignal({ side = "UP", sizeUsd, round, slippage, maxPrice } = {}) {
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
    const slip = Number.isFinite(Number(slippage)) ? Number(slippage) : this.slippage;
    // the user's max entry price caps the slippage too
    const ceiling = Math.min(1 - tick, Number(maxPrice) > 0 && Number(maxPrice) < 1 ? Number(maxPrice) : 1);
    const expected = Math.max(quote.price, swept || 0);
    const limit = Math.min(ceiling, expected + Math.max(0, slip));
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
    // Sign at the ceiling, book at the expected fill: the CLOB fills at the resting asks.
    const fillPrice = Number(Math.min(price, expected).toFixed(priceDp));
    const usdOut = makerMicro / 1e6;
    const expectedShares = Number((usdOut / fillPrice).toFixed(4));
    const schedule = { rate: quote.feeRate, exponent: quote.feeExponent };
    const feeUsd = takerFee(expectedShares, fillPrice, schedule);
    return {
      tokenId: quote.tokenId,
      makerAmount: String(makerMicro),
      takerAmount: String(takerMicro),
      side: 0, // BUY
      quote: {
        ...quote,
        asks: undefined,
        price: fillPrice,
        limitPrice: price,
        minShares: shares,
        payout: expectedShares / usdOut,
        sizeUsd: usdOut.toFixed(2),
        shares: expectedShares,
        feeUsd: feeUsd.toFixed(5),
      },
    };
  }

  /**
   * Final result of a round as Polymarket resolved it (Chainlink TWAP),
   * read from Gamma's outcomePrices once the market is closed.
   */
  async resolvedOutcome(slug, bet = null) {
    if (!slug || typeof this.client.eventBySlug !== "function") return { resolved: false };
    const res = await this.client.eventBySlug(slug);
    if (!res || !res.ok || !res.json) return { resolved: false };
    const market = Array.isArray(res.json.markets) && res.json.markets[0] ? res.json.markets[0] : res.json;
    if (bet) {
      const tokens = parseList(market.clobTokenIds).map(String);
      const labels = parseList(market.outcomes).map((value) => String(value).toUpperCase());
      const index = labels.indexOf(bet.side);
      if (!bet.tokenId || index < 0 || String(tokens[index]) !== String(bet.tokenId) || (market.slug && market.slug !== slug)) return { resolved: false };
    }
    if (market.closed !== true || market.umaResolutionStatus !== "resolved") return { resolved: false };
    const outcomes = parseList(market.outcomes).map((o) => String(o).toLowerCase());
    const prices = parseList(market.outcomePrices).map(Number);
    if (prices.length !== 2 || outcomes.length !== 2 || prices.filter((p) => p === 1).length !== 1 || prices.filter((p) => p === 0).length !== 1) return { resolved: false };
    const winner = prices.findIndex((p) => p === 1);
    if (winner < 0 || !outcomes[winner]) return { resolved: false };
    const name = outcomes[winner];
    const outcome = name === "up" || name === "yes" ? "UP" : name === "down" || name === "no" ? "DOWN" : null;
    return outcome ? { resolved: true, outcome } : { resolved: false };
  }

  async inspectOrder(pending) {
    try {
      this._syncClientIdentity();
      return await require("./orderEvidence").inspectOrder(this.client, pending, this.walletAddress);
    } catch {
      return { ok: false, reason: "order_lookup_unavailable" };
    }
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
