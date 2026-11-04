"use strict";

/* One WebSocket kept alive for the collector: a text PING on a timer, a watchdog that replaces a socket that stays open
 * but goes silent, immediate or capped exponential reconnects, and a list of endpoints to fall back through (an endpoint that fails
 * before it opens is skipped for a while). Everything time-based runs in tick(now), so tests need no timers.
 * Status events: connecting, open, close, timeout, silent, error (with the endpoint id). */
const RETRY_MIN = 1000;
const RETRY_MAX = 30000;
const SKIP_FAILED_MS = 15 * 60000;
const STABLE_MS = 20000;
const QUICK_MAX = 6;   // immediate reconnects a minute after short connections that were delivering data

class Socket {
  constructor({ name, endpoints, WebSocket = globalThis.WebSocket, now = Date.now, ping = null, pingMs = 10000, idleMs = 30000, openTimeoutMs = 15000,
    onOpen = () => {}, onMessage = () => {}, onStatus = () => {} }) {
    if (!WebSocket) throw new Error("collector_websocket_missing");
    if (!Array.isArray(endpoints) || !endpoints.length) throw new Error("collector_endpoints_missing");
    Object.assign(this, { name, endpoints, WS: WebSocket, now, ping, pingMs, idleMs, openTimeoutMs, onOpen, onMessage, onStatus });
    this.ws = null;
    this.state = "idle";
    this.endpoint = null;
    this.failedUntil = new Map();
    this.wait = RETRY_MIN;
    this.retryAt = 0;
    this.connectAt = 0;
    this.lastMsg = 0;
    this.lastPing = 0;
    this.openedAt = 0;
    this.opens = 0;
    this.gotData = false;
    this.quick = [];
    this.closed = false;
  }

  start() { if (this.state === "idle") this._connect(this.now()); return this; }

  get open() { return this.state === "open"; }

  send(msg) {
    if (this.state !== "open" || !this.ws) return false;
    try { this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)); return true; } catch { return false; }
  }

  tick(now = this.now()) {
    if (this.closed) return;
    if (this.state === "waiting" && now >= this.retryAt) this._connect(now);
    else if (this.state === "connecting" && now - this.connectAt > this.openTimeoutMs) {
      this.onStatus("timeout", this.endpoint);
      this._fail(now);
    } else if (this.state === "open") {
      if (this.ping && now - this.lastPing >= this.pingMs) { this.lastPing = now; this.send(this.ping); }
      if (this.idleMs && now - this.lastMsg > this.idleMs) {
        this.onStatus("silent", this.endpoint);
        this._drop(now);
      }
    }
  }

  close() {
    this.closed = true;
    this.state = "closed";
    this._detach();
  }

  _pick(now) {
    const usable = this.endpoints.filter((e) => !(this.failedUntil.get(e.id) > now));
    return usable[0] || this.endpoints[0];
  }

  _connect(now) {
    if (this.closed) return;
    const ep = this._pick(now);
    this.endpoint = ep.id;
    this.state = "connecting";
    this.connectAt = now;
    this.onStatus("connecting", ep.id);
    let ws;
    try { ws = new this.WS(ep.url); } catch (e) { this.onStatus("error", ep.id); this._fail(now); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const t = this.now();
      this.state = "open";
      this.opens += 1;
      this.openedAt = t;
      this.gotData = false;
      this.failedUntil.delete(ep.id);
      this.lastMsg = t;
      this.lastPing = t;
      this.onStatus("open", ep.id);
      try { this.onOpen((m) => this.send(m), ep.id); } catch (e) { this.onStatus("error", ep.id); }
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastMsg = this.now();
      let data = e && e.data;
      if (typeof data !== "string") {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) data = Buffer.from(data).toString("utf8");
        else return;
      }
      if (data === "PONG" || data === "pong") return;
      this.gotData = true;
      try { this.onMessage(data, ep.id); } catch (err) { this.onStatus("error", ep.id); }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      const t = this.now();
      if (this.state === "open") { this.onStatus("close", ep.id, { code: e && e.code != null ? e.code : null, reason: (e && e.reason) || null }); this._drop(t, true); }
      else this._fail(t);
    };
    ws.onerror = () => {};
  }

  // Never opened: this endpoint sits out a while and the next one is tried at once (after the backoff once all failed).
  _fail(now) {
    const id = this.endpoint;
    this._detach();
    if (this.closed) return;
    this.failedUntil.set(id, now + SKIP_FAILED_MS);
    const allFailed = this.endpoints.every((e) => this.failedUntil.get(e.id) > now);
    this.state = "waiting";
    this.retryAt = allFailed ? now + this.wait : now;
    if (allFailed) { this.wait = Math.min(this.wait * 2, RETRY_MAX); this.failedUntil.clear(); }
  }

  // Was open and went away: reconnect at once after a connection that held a while or was delivering data (servers
  // drop busy sockets now and then, Polymarket with 1013 "slow consumer", and every second counts as a gap), at most
  // QUICK_MAX times a minute for short ones; otherwise back off. Preferred endpoints first.
  _drop(now, closedByPeer = false) {
    this._detach(!closedByPeer);
    if (this.closed) return;
    this.quick = this.quick.filter((t) => now - t < 60000);
    const held = now - this.openedAt >= STABLE_MS;
    if (held || (this.gotData && this.quick.length < QUICK_MAX)) {
      if (!held) this.quick.push(now);
      this.wait = RETRY_MIN;
      this._connect(now);
      return;
    }
    this.state = "waiting";
    this.retryAt = now + this.wait;
    this.wait = Math.min(this.wait * 2, RETRY_MAX);
  }

  _detach(closeIt = true) {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (closeIt) { try { ws.close(); } catch {} }
  }
}

module.exports = { Socket, RETRY_MIN, RETRY_MAX, SKIP_FAILED_MS, STABLE_MS, QUICK_MAX };
