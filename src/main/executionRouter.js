"use strict";

const crypto = require("crypto");
const path = require("path");
const { SettingsStore } = require("./settingsStore");
const { ExecutionHost, fault } = require("./executionHost");
const { RemoteClient, normalizeServerUrl } = require("./remoteClient");

class ExecutionRouter {
  constructor({ userDataDir, onEvent = () => {}, host, clientFactory = (value) => new RemoteClient(value), pollMs = 2000, resetWaitMs = 20000, resetRetryMs = 1000 }) {
    this.onEvent = onEvent;
    this.resetWaitMs = Math.max(0, Number(resetWaitMs) || 0);
    this.resetRetryMs = Math.max(20, Number(resetRetryMs) || 1000);
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
    if (this.mode !== "local") {
      if (["reset", "reset-agent"].includes(this.connection.value.transition?.target)) this.host.engine.stop();
      else this.host.quiesce();
    }
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
      hasResetCredential: Boolean(this.connection.value.resetNewToken && !this.connection.value.resetSession),
      owner: this.status?.owner || "unassigned",
      switching: this.switching,
      error: transition ? "handoff_pending" : this.status?.resetPending ? "reset_in_progress" : this.error,
      pendingTarget: ["reset", "reset-agent"].includes(transition?.target) ? null : transition?.target || null,
      blocked: Boolean(transition || this.status?.resetPending || (this.mode !== "local" && !this.connected)),
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
      const existingClaim = this.connection.value.transition?.target === "claim";
      const agentReset = this.connection.value.transition?.target === "reset-agent";
      if ((!reconnect && this.mode !== "local" && !existingClaim && !agentReset) || (this.connection.value.transition && !existingClaim && !agentReset) || !this.host.idle()) throw fault("server_config_locked");
      if (existingClaim) return this._completeClaim();
      const serverToken = token || this.connection.value.serverToken;
      if (typeof serverToken !== "string" || serverToken.length < 32 || /[\r\n]/.test(serverToken)) throw fault("invalid_server_token");
      const status = await this.clientFactory({ url: serverUrl, token: serverToken }).request("/v1/status");
      if (status.protocol !== 1) throw fault("protocol_mismatch");
      if (agentReset && !(status.owner === "server" && status.resetUnclaimed && !status.deviceId)) throw fault("reset_in_progress");
      if (status.owner === "server" && status.resetUnclaimed && !status.deviceId) {
        this.host.quiesce();
        const transition = { target: "claim", requestId: crypto.randomUUID() };
        this.connection.save({ serverUrl, serverToken, executionMode: "transition", transition });
        this.mode = "transition";
        return this._completeClaim();
      }
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

  async _completeClaim() {
    const transition = this.connection.value.transition;
    if (transition?.target !== "claim") throw fault("handoff_pending");
    await this.client().request("/v1/register", { deviceId: this.connection.value.deviceId, requestId: transition.requestId });
    const status = await this.client().request("/v1/status");
    if (status.owner !== "server" || status.deviceId !== this.connection.value.deviceId) throw fault("ownership_conflict");
    const state = (await this.client().request("/v1/snapshot")).state;
    if (!state) throw fault("remote_unavailable");
    this.connection.save({ executionMode: "server", transition: null });
    this.mode = "server"; this.status = status; this.remoteState = state; this.connected = true; this.error = null; this.lastSeenAt = Date.now();
    this.syncTelegram(); this.syncResearch();
    return this.execution();
  }

  getResetCredential() { return this.connection.value.resetNewToken || ""; }

  async resetAccess({ url, token, code } = {}) {
    return this._serial(async () => {
      const existing = this.connection.value.resetSession;
      const serverUrl = existing?.url || normalizeServerUrl(url || this.connection.value.serverUrl);
      const serverToken = existing ? this.connection.value.serverToken : (token || this.connection.value.serverToken);
      if (typeof serverToken !== "string" || Buffer.byteLength(serverToken) < 32 || /\s/.test(serverToken)) throw fault("invalid_server_token");
      if (typeof code !== "string" || !code) throw fault("reset_code_invalid");
      let session = existing;
      if (!session) {
        if (this.connection.value.transition) throw fault("handoff_pending");
        const oldClient = this.clientFactory({ url: serverUrl, token: serverToken });
        await oldClient.request("/v1/reset/verify", { code });
        const status = await oldClient.request("/v1/status");
        const localOwner = status.owner === "local" && Boolean(status.deviceId);
        const selfLocalOwner = localOwner && status.deviceId === this.connection.value.deviceId;
        if (localOwner && !selfLocalOwner && !status.deviceProofEnrolled) throw fault("reset_local_owner_unverified");
        if (!selfLocalOwner) this.host.quiesce(); else { await this._enrollLocalDevice(oldClient); this.host.engine.stop(); }
        session = { url: serverUrl, requestId: crypto.randomUUID(), previousMode: this.mode, localOwner: selfLocalOwner };
        const nextToken = crypto.randomBytes(32).toString("base64url");
        this.connection.save({ serverUrl, serverToken, resetNewToken: nextToken, resetSession: session,
          executionMode: "transition", transition: { target: "reset", requestId: session.requestId } });
        this.mode = "transition";
        this.syncTelegram(); this.syncResearch();
      }
      const nextToken = this.connection.value.resetNewToken;
      if (!nextToken) throw fault("reset_recovery_unavailable");
      const newClient = this.clientFactory({ url: serverUrl, token: nextToken });
      let completed = false;
      try {
        const status = await newClient.request("/v1/status");
        completed = Boolean(status.protocol === 1 && (status.resetUnclaimed || (status.owner === "local" && !status.deviceId)));
      } catch { /* reset may not yet have committed */ }
      const deadline = Date.now() + this.resetWaitMs;
      while (!completed) {
        try {
          let bundle = null;
          if (session.localOwner) {
            // A retry must authenticate again before touching a local position.
            await this.clientFactory({ url: serverUrl, token: serverToken }).request("/v1/reset/verify", { code });
            const engine = this.host.engine;
            const pending = engine.journal?.pendingOrder?.();
            if (pending?.action === "SELL") {
              const recovery = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: pending.evidence?.orderId, confirm: true });
              if (!recovery?.ok) throw fault("reset_sale_pending");
            } else if (pending) throw fault("reset_position_open");
            if (engine.liveBet) {
              const sold = await engine.closePositionForReset();
              if (!sold?.ok || !sold.complete) throw fault("reset_position_open");
            }
            try { this.host.quiesce(); } catch { throw fault("reset_position_open"); }
            bundle = await this.host.exportBundle();
          }
          const result = await this.clientFactory({ url: serverUrl, token: serverToken }).request("/v1/reset", {
            requestId: session.requestId, code, newToken: nextToken,
            ...(session.localOwner ? { deviceId: this.connection.value.deviceId, deviceProof: this.connection.value.deviceProof, bundle } : {}),
          });
          completed = result?.ok === true;
          if (!completed) throw fault("reset_outcome_unknown");
        } catch (err) {
          if (["reset_waiting_owner", "reset_position_open", "reset_sale_pending"].includes(err.code) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, this.resetRetryMs));
            continue;
          }
          // Once a reset intent is persisted, never silently unlock on a
          // failure: the server or a sale may already be in progress.
          throw err;
        }
      }
      this.connection.save({ executionMode: session.previousMode, transition: null, resetSession: null });
      this.mode = session.previousMode; this.connected = false; this.error = "remote_unauthorized";
      this.syncTelegram(); this.syncResearch();
      return { ok: true, newToken: nextToken, execution: this.execution() };
    });
  }

  async _enrollLocalDevice(client = this.client()) {
    let proof = this.connection.value.deviceProof;
    if (!proof) { proof = crypto.randomBytes(32).toString("base64url"); this.connection.save({ deviceProof: proof }); }
    await client.request("/v1/device-enroll", { deviceId: this.connection.value.deviceId, deviceProof: proof });
  }

  async _followRemoteReset(status) {
    return this._serial(async () => {
      const requestId = status.resetRequestId;
      if (!requestId || !this.connection.value.deviceProof) return;
      const transition = this.connection.value.transition;
      if (transition && (transition.target !== "reset-agent" || transition.requestId !== requestId)) return;
      if (!transition) {
        this.host.engine.stop();
        this.connection.save({ executionMode: "transition", transition: { target: "reset-agent", requestId } });
        this.mode = "transition"; this.syncTelegram(); this.syncResearch();
      }
      const engine = this.host.engine, pending = engine.journal?.pendingOrder?.();
      if (pending?.action === "SELL") {
        const recovery = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: pending.evidence?.orderId, confirm: true });
        if (!recovery?.ok) return;
      } else if (pending) return;
      if (engine.liveBet) {
        const result = await engine.closePositionForReset();
        if (!result?.ok || !result.complete) return;
      }
      try { this.host.quiesce(); } catch { return; }
      const bundle = await this.host.exportBundle();
      await this.client().request("/v1/reset/local-ready", { requestId, deviceId: this.connection.value.deviceId,
        deviceProof: this.connection.value.deviceProof, bundle });
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
      const status = await this._status();
      if (status.owner === "local" && status.deviceId === this.connection.value.deviceId) {
        if (status.resetPending && status.resetRequestId) await this._followRemoteReset(status);
        else if (!status.deviceProofEnrolled && this.mode === "local") await this._enrollLocalDevice();
      }
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
      if (target === "claim") return { ok: true, execution: await this._completeClaim() };
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
      if (status.resetPending || status.owner !== "local" || status.deviceId !== this.connection.value.deviceId) throw fault("ownership_conflict");
    }
    const result = await this.host.call(method, args);
    return result?.settings ? this._decorate(result) : result;
  }

  dispatch(method, args = []) {
    if (["aiModels", "aiRecommend", "aiLocalPull"].includes(method)) return this.call(method, args);
    return this._serial(() => this.call(method, args));
  }
  dispose() {
    clearInterval(this.timer);
    this.host.dispose();
  }
}

module.exports = { ExecutionRouter };
