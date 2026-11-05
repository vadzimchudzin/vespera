"use strict";

// Public market data only: no keys, no cookies, no account. Every request has a timeout and a size cap, so a slow
// or hostile endpoint can neither stall the desk nor fill its memory. With a proxy (proxy.js), Polymarket goes through
// it and nowhere else: a proxy that is set but unusable fails the request, it never falls back to a direct call.

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function readText(response, maxBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* the stream is dropped either way */ }
        throw fail("agents_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw fail("agents_response_too_large");
  return text;
}

function createNet({ fetchImpl = globalThis.fetch, timeoutMs = 15000, proxy = null } = {}) {
  async function text(url, { method = "GET", body = null, headers = {}, timeout = timeoutMs, maxBytes = 8 * 1024 * 1024 } = {}) {
    const hdrs = { accept: "application/json, application/xml;q=0.9, */*;q=0.5", ...(body != null ? { "content-type": "application/json" } : {}), ...headers };
    if (proxy && proxy.covers(url)) return proxy.request(url, { method, body, headers: hdrs, timeout, maxBytes });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: hdrs,
        body: body == null ? undefined : JSON.stringify(body),
      });
      if (!response || typeof response.status !== "number") throw fail("agents_source_unavailable");
      const out = await readText(response, maxBytes);
      if (response.status < 200 || response.status >= 300) throw fail(response.status === 429 ? "agents_rate_limited" : `agents_http_${response.status}`);
      return out;
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("agents_")) throw error;
      if (controller.signal.aborted) throw fail("agents_timeout");
      throw fail("agents_source_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  async function json(url, options) {
    const raw = await text(url, options);
    try { return JSON.parse(raw); } catch { throw fail("agents_bad_json"); }
  }
  return { text, json };
}

module.exports = { createNet, fail };
