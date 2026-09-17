"use strict";

const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const DEFAULT_CLOB = "https://clob.polymarket.com";
const DEFAULT_GAMMA = "https://gamma-api.polymarket.com";

function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
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
          "User-Agent": "Vespera/0.8.8",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...headers,
        },
        timeout: timeoutMs,
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
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

class ClobClient {
  constructor(options = {}) {
    this.clobUrl = String(options.clobUrl || DEFAULT_CLOB).replace(/\/$/, "");
    this.gammaUrl = String(options.gammaUrl || DEFAULT_GAMMA).replace(/\/$/, "");
    this.request = options.request || requestJson;
    this.apiKey = options.apiKey || "";
    this.apiSecret = options.apiSecret || "";
    this.apiPassphrase = options.apiPassphrase || "";
    this.walletAddress = options.walletAddress || "";
  }

  configure(patch = {}) {
    if (patch.apiKey != null) this.apiKey = patch.apiKey;
    if (patch.apiSecret != null) this.apiSecret = patch.apiSecret;
    if (patch.apiPassphrase != null) this.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.walletAddress = patch.walletAddress;
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

  async ok() {
    return this.request(`${this.clobUrl}/`);
  }

  async eventBySlug(slug) {
    return this.request(`${this.gammaUrl}/events/slug/${encodeURIComponent(slug)}`);
  }

  async marketBySlug(slug) {
    return this.request(`${this.gammaUrl}/markets/slug/${encodeURIComponent(slug)}`);
  }

  async authGet(path) {
    if (!this.hasL2()) {
      return { ok: false, status: 0, latencyMs: 0, json: null, raw: "missing_l2" };
    }
    const headers = l2Headers({
      address: this.walletAddress,
      apiKey: this.apiKey,
      secret: this.apiSecret,
      passphrase: this.apiPassphrase,
      method: "GET",
      path,
    });
    return this.request(`${this.clobUrl}${path}`, { method: "GET", headers });
  }

  async balanceAllowance() {
    return this.authGet("/balance-allowance?asset_type=COLLATERAL");
  }
}

module.exports = {
  ClobClient,
  requestJson,
  l2Headers,
  DEFAULT_CLOB,
  DEFAULT_GAMMA,
};
