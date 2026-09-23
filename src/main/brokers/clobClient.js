"use strict";

const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

/**
 * Optional outbound proxy. Polymarket geoblocks a list of jurisdictions
 * (Belarus among them) and answers from a blocked IP with a Cloudflare
 * rejection, so the app can route its calls through a proxy instead.
 */
let proxyAgent = null;
let proxyUrl = "";
let proxyError = null;

/**
 * "host:port" without a scheme is read as HTTP; socks4/5 go through a SOCKS
 * agent. Anything else is refused so a typo never silently goes direct.
 */
function normalizeProxyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

function setProxy(url) {
  const next = normalizeProxyUrl(url);
  if (next === proxyUrl) return proxyAgent;
  proxyUrl = next;
  proxyAgent = null;
  proxyError = null;
  if (!next) return null;
  try {
    const scheme = new URL(next).protocol.replace(/:$/, "").toLowerCase();
    if (/^socks(4a?|5h?)?$/.test(scheme)) {
      // eslint-disable-next-line global-require
      const { SocksProxyAgent } = require("socks-proxy-agent");
      proxyAgent = new SocksProxyAgent(next);
    } else if (scheme === "http" || scheme === "https") {
      // eslint-disable-next-line global-require
      const { HttpsProxyAgent } = require("https-proxy-agent");
      proxyAgent = new HttpsProxyAgent(next);
    } else {
      throw new Error(`unsupported proxy scheme: ${scheme}`);
    }
  } catch (err) {
    proxyAgent = null;
    proxyError = String((err && err.message) || err);
  }
  return proxyAgent;
}

function currentProxy() {
  return { url: proxyUrl.replace(/\/\/[^@/]*@/, "//***@"), active: Boolean(proxyAgent), error: proxyError };
}

const APP_VERSION = (() => {
  try {
    return require("../../../package.json").version;
  } catch {
    return "dev";
  }
})();

const DEFAULT_CLOB = "https://clob.polymarket.com";
const DEFAULT_GAMMA = "https://gamma-api.polymarket.com";

function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A configured but unusable proxy must not silently fall back to a direct call.
    if (proxyUrl && !proxyAgent) {
      resolve({
        ok: false,
        status: 0,
        latencyMs: 0,
        json: null,
        raw: `proxy_unavailable: ${proxyError || "agent not loaded"}`,
        networkError: `proxy_unavailable: ${proxyError || "agent not loaded"}`,
      });
      return;
    }
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": `Vespera/${APP_VERSION}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...headers,
        },
        timeout: timeoutMs,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            latencyMs: Date.now() - started,
            json,
            raw,
          });
        });
      }
    );
    const fail = (reason) => {
      resolve({
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        json: null,
        raw: reason,
        networkError: reason,
      });
    };
    req.on("timeout", () => {
      req.destroy();
      fail("timeout");
    });
    req.on("error", (err) => fail(String((err && err.message) || err)));
    if (payload) req.write(payload);
    req.end();
  });
}

function l2Headers({ address, apiKey, secret, passphrase, method, path, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const message = `${timestamp}${String(method || "GET").toUpperCase()}${path}${payload}`;
  let key;
  try {
    key = Buffer.from(String(secret), "base64");
  } catch {
    key = Buffer.from(String(secret));
  }
  const signature = crypto.createHmac("sha256", key).update(message).digest("base64url");
  const padded = signature.length % 4 === 0 ? signature : signature + "=".repeat(4 - (signature.length % 4));
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: padded,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function _parseList(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.markets)) return json.markets;
  return [];
}

function _mapTokenIds(markets) {
  return markets.map((m) => {
    const tokens = Array.isArray(m.tokens) ? m.tokens : [];
    return {
      slug: m.slug || m.conditionId || "",
      question: m.question || m.title || "",
      conditionId: m.conditionId || "",
      tokens: tokens.map((t) => ({
        tokenId: String(t.token_id || t.tokenId || ""),
        outcome: t.outcome || "",
      })),
      active: Boolean(m.active),
      closed: Boolean(m.closed),
      endDate: m.endDate || m.end_date_iso || null,
    };
  });
}

// ── ClobClient ─────────────────────────────────────────────────────────────

class ClobClient {
  constructor(options = {}) {
    if (options.proxyUrl != null) setProxy(options.proxyUrl);
    this.clobUrl = String(options.clobUrl || DEFAULT_CLOB).replace(/\/$/, "");
    this.gammaUrl = String(options.gammaUrl || DEFAULT_GAMMA).replace(/\/$/, "");
    this.request = options.request || requestJson;
    this.apiKey = options.apiKey || "";
    this.apiSecret = options.apiSecret || "";
    this.apiPassphrase = options.apiPassphrase || "";
    this.walletAddress = options.walletAddress || "";
    // L2 headers identify the signing key, not the funding wallet
    this.signerAddress = options.signerAddress || "";
    this.signatureType = options.signatureType == null ? null : Number(options.signatureType);
  }

  authAddress() {
    return this.signerAddress || this.walletAddress;
  }

  configure(patch = {}) {
    if (patch.proxyUrl != null) setProxy(patch.proxyUrl);
    if (patch.apiKey != null) this.apiKey = patch.apiKey;
    if (patch.apiSecret != null) this.apiSecret = patch.apiSecret;
    if (patch.apiPassphrase != null) this.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.walletAddress = patch.walletAddress;
    if (patch.signerAddress !== undefined) this.signerAddress = patch.signerAddress || "";
    if (patch.signatureType !== undefined) {
      this.signatureType = patch.signatureType == null ? null : Number(patch.signatureType);
    }
    if (patch.clobUrl != null) this.clobUrl = String(patch.clobUrl).replace(/\/$/, "");
    if (patch.gammaUrl != null) this.gammaUrl = String(patch.gammaUrl).replace(/\/$/, "");
    return this;
  }

  hasL2() {
    return Boolean(this.apiKey && this.apiSecret && this.apiPassphrase && this.walletAddress);
  }

  async time() {
    return this.request(`${this.clobUrl}/time`);
  }

  /**
   * Polymarket's own jurisdiction check. Tells us whether this IP may trade
   * at all, which is a different failure from "the host is unreachable".
   */
  async geoblock() {
    const res = await this.request("https://polymarket.com/api/geoblock", { timeoutMs: 10000 });
    if (!res.ok || !res.json) return { ok: false, reason: res.raw || `http_${res.status}` };
    return {
      ok: true,
      blocked: Boolean(res.json.blocked),
      country: res.json.country || null,
      region: res.json.region || null,
      ip: res.json.ip || null,
    };
  }

  async ok() {
    return this.request(`${this.clobUrl}/`);
  }

  async eventBySlug(slug) {
    return this.request(`${this.gammaUrl}/events/slug/${encodeURIComponent(slug)}`);
  }

  async marketBySlug(slug) {
    return this.request(`${this.gammaUrl}/markets/slug/${encodeURIComponent(slug)}`);
  }

  /**
   * Fetch top-of-book for a given outcome token.
   * @param {string} tokenId
   */
  async getOrderBook(tokenId) {
    return this.request(`${this.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`);
  }

  /** Mid price of a token, 0..1. Public endpoint, no auth. */
  async midpoint(tokenId) {
    return this.request(`${this.clobUrl}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
  }

  /**
   * Best executable price for one side of the book.
   * side="buy" returns what a taker pays to buy the token.
   */
  async price(tokenId, side = "buy") {
    const s = side === "sell" ? "sell" : "buy";
    return this.request(
      `${this.clobUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=${s}`
    );
  }

  /** V2 market parameters: tick (mts), min size (mos), fee details (fd). Public. */
  async clobMarketInfo(conditionId) {
    return this.request(`${this.clobUrl}/clob-markets/${encodeURIComponent(conditionId)}`);
  }

  /**
   * Fetch active markets from Gamma, optionally filtered by resolution timeframe tags.
   * @param {object} [opts]
   * @param {string[]} [opts.timeframes] - e.g. ["1d", "1w"]
   * @param {number}  [opts.limit=50]
   */
  async fetchActiveMarkets({ timeframes, limit = 50 } = {}) {
    const qs = new URLSearchParams({ active: "true", closed: "false", limit: String(limit) });
    if (timeframes && timeframes.length) {
      qs.set("tag", timeframes.join(","));
    }
    const res = await this.request(`${this.gammaUrl}/markets?${qs}`);
    return { ...res, markets: _mapTokenIds(_parseList(res.json)) };
  }

  /**
   * POST a signed V2 order to the CLOB.
   * @param {object} signedOrder - { order, signature, orderType? } from orderSigner.signOrder()
   */
  async postOrder(signedOrder) {
    if (!this.hasL2()) {
      return { ok: false, status: 0, latencyMs: 0, json: null, raw: "missing_l2" };
    }
    // Signature goes inside the order, `side` is a string on the wire, `salt`
    // a number, `owner` the API key. `expiration` is wire-only in V2.
    const o = signedOrder.order || {};
    const bodyObj = {
      order: {
        salt: Number(o.salt),
        maker: o.maker,
        signer: o.signer,
        tokenId: String(o.tokenId),
        makerAmount: String(o.makerAmount),
        takerAmount: String(o.takerAmount),
        side: o.side === 1 || o.side === "SELL" ? "SELL" : "BUY",
        signatureType: Number(o.signatureType) || 0,
        timestamp: String(o.timestamp),
        metadata: o.metadata,
        builder: o.builder,
        expiration: String(o.expiration || "0"),
        signature: signedOrder.signature,
      },
      owner: this.apiKey,
      orderType: signedOrder.orderType || "FOK",
      deferExec: false,
    };
    const path = "/order";
    const headers = l2Headers({
      address: this.authAddress(),
      apiKey: this.apiKey,
      secret: this.apiSecret,
      passphrase: this.apiPassphrase,
      method: "POST",
      path,
      body: bodyObj,
    });
    const res = await this.request(`${this.clobUrl}${path}`, {
      method: "POST",
      headers,
      body: bodyObj,
    });
    // HTTP 200 is not enough: a refused order comes back as success:false + errorMsg.
    if (res.ok && res.json && res.json.success === false) {
      return { ...res, ok: false, raw: res.json.errorMsg || res.raw || "order_rejected" };
    }
    return res;
  }

  /**
   * Exchange an L1 signature for L2 credentials.
   * Tries derive first (returns the existing key pair for this signer) and
   * falls back to create for a signer that has never had one.
   */
  async deriveApiKey({ address, signature, timestamp, nonce }) {
    const headers = {
      POLY_ADDRESS: address,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: String(timestamp),
      POLY_NONCE: String(nonce == null ? 0 : nonce),
    };
    let res = await this.request(`${this.clobUrl}/auth/derive-api-key`, { headers });
    if (!res.ok) {
      res = await this.request(`${this.clobUrl}/auth/api-key`, { method: "POST", headers });
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: res.raw || `http_${res.status}` };
    }
    const j = res.json || {};
    const apiKey = j.apiKey || j.api_key;
    const secret = j.secret || j.api_secret;
    const passphrase = j.passphrase || j.api_passphrase;
    if (!apiKey || !secret || !passphrase) {
      return { ok: false, status: res.status, message: "incomplete_credentials" };
    }
    return { ok: true, apiKey, secret, passphrase };
  }

  async authGet(path) {
    if (!this.hasL2()) {
      return { ok: false, status: 0, latencyMs: 0, json: null, raw: "missing_l2" };
    }
    // query parameters are not part of the signed path
    const signedPath = path.split("?")[0];
    const headers = l2Headers({
      address: this.authAddress(),
      apiKey: this.apiKey,
      secret: this.apiSecret,
      passphrase: this.apiPassphrase,
      method: "GET",
      path: signedPath,
    });
    return this.request(`${this.clobUrl}${path}`, { method: "GET", headers });
  }

  async balanceAllowance() {
    const qs = new URLSearchParams({ asset_type: "COLLATERAL" });
    if (this.signatureType != null) qs.set("signature_type", String(this.signatureType));
    return this.authGet(`/balance-allowance?${qs}`);
  }
}

module.exports = {
  ClobClient,
  setProxy,
  normalizeProxyUrl,
  currentProxy,
  requestJson,
  l2Headers,
  _parseList,
  _mapTokenIds,
  DEFAULT_CLOB,
  DEFAULT_GAMMA,
};
