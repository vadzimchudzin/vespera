"use strict";

const https = require("https");
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
          "User-Agent": "Vespera/0.8.6",
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

class ClobClient {
  constructor(options = {}) {
    this.clobUrl = String(options.clobUrl || DEFAULT_CLOB).replace(/\/$/, "");
    this.gammaUrl = String(options.gammaUrl || DEFAULT_GAMMA).replace(/\/$/, "");
    this.request = options.request || requestJson;
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
}

module.exports = {
  ClobClient,
  requestJson,
  DEFAULT_CLOB,
  DEFAULT_GAMMA,
};
