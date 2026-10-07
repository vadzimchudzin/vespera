"use strict";

const crypto = require("crypto");
const path = require("path");
const { SettingsStore } = require("./settingsStore");
const { ExecutionHost, fault } = require("./executionHost");
const { RemoteClient, normalizeServerUrl } = require("./remoteClient");

class ExecutionRouter {
  constructor({ userDataDir, onEvent = () => {}, host, clientFactory = (value) => new RemoteClient(value), pollMs = 2000 }) {
    this.onEvent = onEvent;
    this.connection = new SettingsStore(path.join(userDataDir, "remote-control"));
    if (!this.connection.value.deviceId) this.connection.save({ deviceId: crypto.randomUUID(), executionMode: "local" });
    this.host = host || new ExecutionHost({ userDataDir, onEvent: (evt) => {
      if (this.mode === "local") {
        this.onEvent(this._decorateEvent(evt));
      }
    } });
    this.clientFactory = clientFactory;
    this.mode = this.connection.value.executionMode || "local";
    this.remoteState = this.connection.value.cachedState || null;
    this.status = null;
    this.connected = false;
    this.error = null;
    this.switching = false;
    this.cursor = 0;
    this.queue = Promise.resolve();
    if (this.mode !== "local") this.host.quiesce();
    this.timer = setInterval(() => this.poll().catch(() => {}), pollMs);
    this.timer.unref?.();
    if (this.configured()) this.poll().catch(() => {});
    this.syncTelegram();
    this.syncResearch();
  }

  syncResearch() {
    return Promise.resolve(this.host.setResearchContext?.({ active: this.mode === "local" && !this.connection.value.transition })).catch(() => {});
  }

  syncTelegram() {
    return this.host.setTelegramContext?.({
      active: this.mode === "local" && !this.connection.value.transition,
      command: (method, args) => this.call(method, args),
      serialize: (work) => this._serial(work),
      epoch: this.status?.epoch ?? null,
    })?.catch(() => {});
  }

  configured() { return Boolean(this.connection.value.serverUrl && this.connection.value.serverToken); }
  client() { return this.clientFactory({ url: this.connection.value.serverUrl, token: this.connection.value.serverToken }); }

  execution() {
    const transition = this.connection.value.transition;
    return {
      mode: this.mode === "local" ? "local" : "server",
      connected: this.connected,
      configured: this.configured(),
      url: this.connection.value.serverUrl || "",
      hasToken: Boolean(this.connection.value.serverToken),
      owner: this.status?.owner || "unassigned",
      switching: this.switching,
      error: transition ? "handoff_pending" : this.error,
      pendingTarget: transition?.target || null,
      blocked: Boolean(transition || (this.mode !== "local" && !this.connected)),
      lastSeenAt: this.connected ? this.lastSeenAt : null,
      serverVersion: this.status?.version || null,
    };
  }

  _decorate(state) { return { ...state, execution: this.execution() }; }
  _decorateEvent(evt) { return { ...evt, ...(evt.state ? { state: this._decorate(evt.state) } : {}) }; }
  _serial(fn) {
    const result = this.queue.catch(() => {}).then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  async configure({ url, token } = {}) {
    return this._serial(async () => {
      const serverUrl = normalizeServerUrl(url);
      const reconnect = this.mode === "server" && serverUrl === this.connection.value.serverUrl;
      if ((!reconnect && this.mode !== "local") || this.connection.value.transition || !this.host.idle()) throw fault("server_config_locked");
      const serverToken = token || this.connection.value.serverToken;
      if (typeof serverToken !== "string" || serverToken.length < 32 || /[\r\n]/.test(serverToken)) throw fault("invalid_server_token");
      const status = await this.clientFactory({ url: serverUrl, token: serverToken }).request("/v1/status");
      if (status.protocol !== 1) throw fault("protocol_mismatch");
      if (reconnect) {
        if (status.owner !== "server" || status.deviceId !== this.connection.value.deviceId) throw fault("ownership_conflict");
      } else {
        if (status.owner === "server" || (status.deviceId && status.deviceId !== this.connection.value.deviceId)) throw fault("ownership_conflict");
        await this.clientFactory({ url: serverUrl, token: serverToken }).request("/v1/register", {
          deviceId: this.connection.value.deviceId, requestId: crypto.randomUUID(),
        });
      }
      this.connection.save({ serverUrl, serverToken });
      this.status = status;
      this.connected = true;
      this.lastSeenAt = Date.now();
      this.error = null;
      return this.execution();
    });
  }

  async _status() {
    const status = await this.client().request("/v1/status");
    if (status.protocol !== 1) throw fault("protocol_mismatch");
    this.status = status;
    this.connected = true;
    this.lastSeenAt = Date.now();
    this.error = null;
    return status;
  }

  async poll() {
    if (this.polling || this.switching || !this.configured()) return;
    this.polling = true;
    try {
      await this._status();
      if (this.mode === "server" && !this.connection.value.transition) {
        const result = await this.client().request("/v1/snapshot");
        this.remoteState = result.state;
        if (!this.remoteState) throw fault("ownership_conflict");
        const batch = await this.client().request(`/v1/events?after=${this.cursor}`);
        for (const evt of batch.events || []) {
          if (evt.type === "notify") this.onEvent(this._decorateEvent(evt));
        }
        this.cursor = batch.cursor || this.cursor;
        await this.client().request("/v1/heartbeat", { deviceId: this.connection.value.deviceId });
        if (!this.lastCacheAt || Date.now() - this.lastCacheAt >= 30000) {
          this.connection.save({ cachedState: this.remoteState });
          this.lastCacheAt = Date.now();
        }
      }
    } catch (err) {
      this.connected = false;
      this.error = err.code || "remote_unavailable";
    } finally {
      this.polling = false;
      if (this.mode === "server" && this.remoteState) this.onEvent({ type: "state", state: this._decorate(this.remoteState) });
      else this.onEvent({ type: "execution", payload: this.execution(), state: this._decorate(this.host.engine.snapshot()) });
    }
  }

  async switchMode(target) {
    return this._serial(async () => {
      if (!["local", "server"].includes(target)) throw fault("invalid_execution_mode");
      if (target === this.mode && !this.connection.value.transition) return { ok: true, execution: this.execution(), state: await this.call("snapshot") };
      if (!this.configured()) throw fault("server_not_configured");
      this.switching = true;
      try {
        let transition = this.connection.value.transition;
        if (transition && transition.target !== target) throw fault("handoff_pending");
        if (!transition) {
          if (target === "server") this.host.quiesce();
          transition = { target, requestId: crypto.randomUUID() };
          // A crash or lost reply leaves the old local core durably disabled.
          const transferBundle = target === "server" ? JSON.stringify(this.host.exportBundle()) : null;
          this.connection.save({ executionMode: "transition", transition, ...(transferBundle ? { transferBundle } : {}) });
          this.mode = "transition";
        }
        const identity = { deviceId: this.connection.value.deviceId, requestId: transition.requestId };
        if (target === "server") {
          const bundle = JSON.parse(this.connection.value.transferBundle);
          await this.client().request("/v1/activate", { ...identity, bundle });
          this.mode = "server";
        } else {
          const result = await this.client().request("/v1/release", identity);
          await this.host.importBundle(result.bundle);
          this.mode = "local";
          this.remoteState = null;
        }
        this.cursor = 0;
        await this._status();
        if (target === "server") this.remoteState = (await this.client().request("/v1/snapshot")).state;
        this.connection.save({ executionMode: target, transition: null });
        this.connection.clearSecret("transferBundle");
        this.syncTelegram();
        this.syncResearch();
        const state = this._decorate(target === "server" ? this.remoteState : this.host.engine.snapshot());
        this.onEvent({ type: "execution", payload: this.execution(), state });
        return { ok: true, execution: this.execution(), state };
      } catch (err) {
        if (["execution_busy", "execution_not_idle", "settings_locked", "invalid_transfer", "invalid_bundle"].includes(err.code)) {
          try {
            const status = await this._status();
            const source = target === "server" ? "local" : "server";
            if (status.owner === source && status.deviceId === this.connection.value.deviceId) {
              this.mode = source;
              this.connection.save({ executionMode: source, transition: null });
              this.connection.clearSecret("transferBundle");
              this.syncTelegram();
              this.syncResearch();
              return { ok: false, reason: err.code, execution: this.execution() };
            }
          } catch { /* uncertain ownership stays locked */ }
        }
        this.error = err.code || "remote_unavailable";
        this.connected = false;
        return { ok: false, reason: this.connection.value.transition ? "handoff_pending" : this.error, execution: this.execution() };
      } finally {
        this.switching = false;
      }
    });
  }

  async call(method, args = []) {
    if (this.connection.value.transition) {
      if (["snapshot", "warmChart"].includes(method)) return this._decorate(this.remoteState || this.host.engine.snapshot());
      if (method === "getSettings") return this.remoteState?.settings || { locale: this.host.store?.value.locale || "en", theme: this.host.store?.value.theme || "glass-dark" };
      throw fault("handoff_pending");
    }
    if (this.mode === "server") {
      if (method === "getSettings") {
        await this.poll();
        return this.remoteState?.settings || { locale: this.host.store?.value.locale || "en", theme: this.host.store?.value.theme || "glass-dark" };
      }
      if (["snapshot", "warmChart"].includes(method)) {
        await this.poll();
        return this._decorate(this.remoteState || this.host.engine.snapshot());
      }
      const result = await this.client().request("/v1/command", {
        method, args, deviceId: this.connection.value.deviceId, requestId: crypto.randomUUID(),
      });
      return result?.settings ? this._decorate(result) : result;
    }
    // Only the explicitly assigned desktop may start a configured account.
    if (["start", "testOrder"].includes(method) && this.configured()) {
      const status = await this._status();
      if (status.owner !== "local" || status.deviceId !== this.connection.value.deviceId) throw fault("ownership_conflict");
    }
    const result = await this.host.call(method, args);
    return result?.settings ? this._decorate(result) : result;
  }

  dispatch(method, args = []) { return this._serial(() => this.call(method, args)); }
  dispose() {
    clearInterval(this.timer);
    this.host.dispose();
  }
}

module.exports = { ExecutionRouter };
