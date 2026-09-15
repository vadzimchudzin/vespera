"use strict";

const https = require("https");

/**
 * Live Preddy adapter is a stub in v0.1.0.
 * Preddy has no public API key. Ping checks that preddy.trade is reachable.
 * Auto mode refuses to send orders until a real CLOB signer exists.
 */
function request(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = https.get(
      url,
      { headers: { "User-Agent": "Vespera/0.1" }, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          latencyMs: Date.now() - started,
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

class PreddyAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.baseUrl = options.baseUrl || "https://preddy.trade";
  }

  async ping() {
    if (!this.apiKey) {
      return { ok: false, venue: "preddy", message: "missing_key" };
    }
    try {
      const r = await request(this.baseUrl);
      return {
        ok: r.ok,
        venue: "preddy",
        latencyMs: r.latencyMs,
        status: r.status,
        message: r.ok ? "reachable" : `http_${r.status}`,
        trading: false,
        note: "Preddy has no public trading API. Auto stays disabled.",
      };
    } catch (err) {
      return { ok: false, venue: "preddy", message: String(err.message || err) };
    }
  }

  async marketBuy() {
    const err = new Error("auto_not_wired");
    err.code = "auto_not_wired";
    throw err;
  }
}

module.exports = { PreddyAdapter };
