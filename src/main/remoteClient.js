"use strict";

const http = require("http");
const https = require("https");
const { fault } = require("./executionHost");

function normalizeServerUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw fault("invalid_server_url"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw fault("invalid_server_url");
  }
  return url.origin;
}

class RemoteClient {
  constructor({ url, token, timeoutMs = 60_000 }) {
    this.url = normalizeServerUrl(url);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  request(route, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(route, this.url);
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(url, {
        method: payload ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.token}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 24 * 1024 * 1024) req.destroy(fault("remote_response_too_large"));
          else chunks.push(chunk);
        });
        res.on("aborted", () => reject(fault("remote_unavailable")));
        res.on("error", () => reject(fault("remote_unavailable")));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(fault("remote_unauthorized"));
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { return reject(fault("invalid_remote_response")); }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = fault(value.reason || "remote_unavailable");
            reject(err);
          } else resolve(value);
        });
      });
      const timer = setTimeout(() => req.destroy(fault("remote_unavailable")), this.timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(fault("remote_unavailable")));
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { RemoteClient, normalizeServerUrl };
