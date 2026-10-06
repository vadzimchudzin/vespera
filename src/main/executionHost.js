"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Engine } = require("./engine");
const { SettingsStore, DEFAULTS, SECRET_FIELDS, TelegramConfigStore } = require("./settingsStore");
const { TelegramBot, validateToken } = require("./telegramBot");
const { BridgeClient } = require("./brokers/bridge");
const { setProxy } = require("./brokers/clobClient");
const { toCsv } = require("./stats");
const QRCode = require("qrcode");

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  try {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
}

function fault(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const PORTABLE_KEYS = new Set([...Object.keys(DEFAULTS), "depositToken", "depositChain"]);

class ExecutionHost {
  constructor({ userDataDir, direct = false, onEvent = () => {}, engineOptions = {} }) {
    this.root = userDataDir;
    this.direct = direct;
    this.onEvent = onEvent;
    this.engineOptions = engineOptions;
    this.telegramStore = new TelegramConfigStore(path.join(userDataDir, "telegram-private"));
    this.pointer = path.join(userDataDir, "execution-state.json");
    let active = userDataDir;
    if (fs.existsSync(this.pointer)) {
      const state = JSON.parse(fs.readFileSync(this.pointer, "utf8"));
      if (!/^book-[a-f0-9-]+$/.test(state.active || "")) throw fault("invalid_execution_state");
      active = path.join(userDataDir, state.active);
      if (!fs.existsSync(active)) throw fault("missing_execution_state");
    }
    this._open(active);
    this.bridge = new BridgeClient();
    this.telegramContext = { active: false, command: null, serialize: null, epoch: null };
    this.telegramBot = null;
  }

  _open(dir) {
    this.store = new SettingsStore(dir);
    if (this.direct) {
      this.store.save({ proxyUrl: "" });
      setProxy("");
    }
    this.engine = new Engine({ userDataDir: dir, settings: this.store.value, ...this.engineOptions });
    this.unsubscribe = this.engine.on((evt) => {
      // Engine settings events contain the private settings object.
      const safe = evt.type === "settings" ? { ...evt, payload: null } : evt;
      this.onEvent(safe);
      try { this.telegramBot?.enqueueEvent(evt); } catch { /* Telegram delivery is isolated from execution */ }
    });
  }

  idle() {
    const e = this.engine;
    return !e.running && !e._opening && !e._starting && !e.paper.openBet && !e.liveBet &&
      !e.journal.pendingOrder() && !e._testPositionActive();
  }

  quiesce() {
    this.setTelegramContext({ active: false, command: null });
    this.engine.stop();
    if (!this.idle()) throw fault("execution_busy");
    this.engine.market.stop?.();
    return true;
  }

  dispose() {
    this.setTelegramContext({ active: false, command: null });
    this.engine.dispose();
    this.unsubscribe?.();
  }

  async setTelegramContext({ active = false, command = null, serialize = null, epoch = null } = {}) {
    // The service owns its bot lifecycle, including during a refused handoff.
    if (this.telegramRuntime) return;
    this.telegramContext = { active: Boolean(active && typeof command === "function"), command: typeof command === "function" ? command : null,
      serialize: typeof serialize === "function" ? serialize : null, epoch };
    if (this.telegramContext.active && !this.telegramBot) {
      this.telegramBot = new TelegramBot({
        store: this.telegramStore,
        host: this,
        getOwner: () => ({ owner: "local", active: this.telegramContext.active, epoch: this.telegramContext.epoch }),
        command: (method, args) => {
          const context = this.telegramContext;
          if (!context.active || typeof context.command !== "function") throw fault("telegram_owner_inactive");
          return context.command(method, args);
        },
        serialize: (work) => this.telegramContext.serialize ? this.telegramContext.serialize(work) : work(),
        transport: this.engineOptions.telegramTransport || null,
      });
    }
    if (!this.telegramBot) return;
    if (this.telegramContext.active) await this.telegramBot.sync();
    else await this.telegramBot.stop();
  }

  exportBundle() {
    if (!this.idle()) throw fault("execution_busy");
    const settings = {};
    for (const [key, value] of Object.entries(this.engine.settings)) {
      if (PORTABLE_KEYS.has(key)) settings[key] = value;
    }
    const journal = this.engine.journal;
    const cleanRow = (row) => {
      const { order, signature, response, ...safe } = row;
      return safe;
    };
    const checkpoint = JSON.parse(fs.existsSync(journal.statePath)
      ? fs.readFileSync(journal.statePath, "utf8")
      : JSON.stringify({ version: 1, sequence: 0, entries: [] }));
    checkpoint.entries = checkpoint.entries.map(cleanRow);
    return {
      protocol: 1,
      settings,
      history: journal.readAll().slice(-5000).map(cleanRow),
      checkpoint,
    };
  }

  async importBundle(bundle) {
    if (!this.idle()) throw fault("execution_busy");
    if (!bundle || bundle.protocol !== 1 || !bundle.settings || !Array.isArray(bundle.history) ||
        !bundle.checkpoint || bundle.checkpoint.version !== 1 || !Array.isArray(bundle.checkpoint.entries)) {
      throw fault("invalid_transfer");
    }
    const settings = {};
    for (const [key, value] of Object.entries(bundle.settings)) if (PORTABLE_KEYS.has(key)) settings[key] = value;
    if (this.direct) settings.proxyUrl = "";
    else settings.proxyUrl = this.store.value.proxyUrl || "";
    const name = `book-${crypto.randomUUID()}`;
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new SettingsStore(dir);
    store.save(settings);
    fs.writeFileSync(path.join(dir, "journal.jsonl"), bundle.history.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    for (const file of [store.file, path.join(dir, "journal.jsonl")]) {
      const fd = fs.openSync(file, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    atomicJson(path.join(dir, "journal.jsonl.state.json"), bundle.checkpoint);
    // Validate restored risk and positions before changing the durable pointer.
    const candidate = new ExecutionHost({ userDataDir: dir, direct: this.direct, engineOptions: this.engineOptions });
    if (!candidate.idle()) {
      candidate.dispose();
      throw fault("transfer_has_position");
    }
    candidate.dispose();
    this.dispose();
    atomicJson(this.pointer, { version: 1, active: name });
    this._open(dir);
  }

  _patch(patch = {}) {
    const value = typeof patch === "string" ? { apiKey: patch } : { ...patch };
    if (this.direct) value.proxyUrl = "";
    return value;
  }

  _saveAccepted(patch) {
    const accepted = {};
    for (const key of Object.keys(patch)) accepted[key] = this.engine.settings[key];
    for (const key of ["baseUsd", "maxSteps", "fixedStakes", "fastPeriod", "slowPeriod"]) accepted[key] = this.engine.settings[key];
    this.store.save(accepted);
  }

  async call(method, args = []) {
    const e = this.engine;
    switch (method) {
      case "snapshot": return e.snapshot();
      case "warmChart": return e.warmChart();
      case "start": return e.start(args[0] || {});
      case "stop": e.stop(); return e.snapshot();
      case "inspectPendingOrder": {
        const result = await e.inspectPendingOrder();
        return { ...result, clientOrderId: e.journal.pendingOrder()?.clientOrderId || null };
      }
      case "resolvePendingOrder": return e.resolvePendingOrder(args[0] || {});
      case "reconcileFinalSettlement": return e.reconcileFinalSettlement({ attempts: 1 });
      case "setMode":
        await e.setMode(args[0]);
        this.store.save({ mode: e.mode, symbol: e.settings.symbol, timeframe: e.settings.timeframe });
        return e.snapshot();
      case "confirmLot":
        e.confirmLot(args[0], args[1]);
        this.store.save({ baseUsd: e.settings.baseUsd });
        return e.snapshot();
      case "getSettings": {
        const { apiKey, apiSecret, apiPassphrase, privateKey, serverToken, transferBundle, ...safe } = this.store.value;
        return { ...safe, hasApiKey: Boolean(apiKey), hasApiSecret: Boolean(apiSecret), hasApiPassphrase: Boolean(apiPassphrase), hasPrivKey: Boolean(privateKey) };
      }
      case "saveSettings": {
        const patch = this._patch(args[0]);
        try {
          await e.applySettings(patch);
          this._saveAccepted(patch);
          return e.snapshot();
        } catch (err) {
          if (["invalid_settings", "settings_locked"].includes(err.code)) {
            return { ok: false, reason: err.code, field: err.field || null, message: err.message, state: e.snapshot() };
          }
          throw err;
        }
      }
      case "ping":
      case "connect":
      case "deriveKeys": {
        const patch = this._patch(args[0]);
        // Apply the same active-position lock as ordinary settings edits.
        const credentials = {};
        for (const key of [...SECRET_FIELDS, "walletAddress", "walletType", "proxyUrl"]) {
          if (patch[key] != null && (!SECRET_FIELDS.includes(key) || String(patch[key]).trim())) credentials[key] = patch[key];
        }
        await e.applySettings(credentials);
        this._saveAccepted(credentials);
        if (method === "ping") return e.pingApi(patch);
        if (method === "connect") {
          const res = await e.connect(patch);
          if (res.credentials) this.store.save(res.credentials);
          const { credentials: secrets, ...safe } = res;
          return safe;
        }
        const res = await e.deriveApiKeys(patch);
        if (res.ok) this.store.save({ apiKey: res.apiKey, apiSecret: res.apiSecret, apiPassphrase: res.apiPassphrase });
        return { ok: res.ok, reason: res.reason || null, status: res.status || null, signerAddress: res.signerAddress || null, walletType: res.walletType || null };
      }
      case "testOrder": return e.testOrder(args[0] || {});
      case "setStrategy": {
        if (e._opening || e.openBet() || e.journal.pendingOrder()) throw fault("settings_locked");
        const result = e.setStrategy(args[0]);
        if (result.ok) this.store.save({ strategyId: result.strategyId });
        return { ...result, state: e.snapshot() };
      }
      case "resetPaper": {
        const snap = e.resetPaper(args[0]);
        this.store.save({ paperBalance: e.paper.startingBalance.toFixed(2) });
        return snap;
      }
      case "exportCsv": return toCsv(e.journal.readAll());
      case "depositAssets":
        setProxy(this.direct ? "" : e.settings.proxyUrl);
        return { ok: true, tokens: await this.bridge.assets() };
      case "depositAddress": {
        setProxy(this.direct ? "" : e.settings.proxyUrl);
        const wallet = e.settings.walletAddress || "";
        if (!wallet) return { ok: false, reason: "wallet_missing" };
        const all = await this.bridge.addresses(wallet);
        const address = all[args[0]];
        if (!address) return { ok: false, reason: "type_unsupported" };
        return { ok: true, wallet, address, qr: await QRCode.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: "M" }) };
      }
      case "depositStatus":
        setProxy(this.direct ? "" : e.settings.proxyUrl);
        return { ok: true, transactions: await this.bridge.status(args[0]) };
      case "telegramStatus": {
        try {
          const config = this.telegramStore.read();
          const runtime = this.telegramBot?.status() || { enabled: Boolean(config.enabled), connected: false, lastError: config.lastError || null };
          return { enabled: Boolean(config.enabled), connected: runtime.connected, botName: config.botUsername || null,
            hasToken: Boolean(config.token), adminId: config.admins[0] || null, users: config.users.slice(),
            pendingRequests: config.requests.length, failedDeliveries: runtime.deadLetterCount || 0, lastError: runtime.lastError };
        } catch {
          return { enabled: false, connected: false, botName: null, hasToken: false, adminId: null, users: [],
            pendingRequests: 0, failedDeliveries: 0, lastError: "telegram_storage_unavailable" };
        }
      }
      case "telegramConfigure": {
        const input = args[0];
        if (typeof input !== "object" || !input || Array.isArray(input) ||
            (input.enabled !== undefined && typeof input.enabled !== "boolean")) return { ok: false, reason: "telegram_config_invalid" };
        const old = this.telegramStore.read();
        const suppliedToken = Object.prototype.hasOwnProperty.call(input, "token");
        const token = suppliedToken ? input.token : old.token;
        if (suppliedToken && !validateToken(token)) return { ok: false, reason: "telegram_token_invalid" };
        const enabled = input.enabled === undefined ? old.enabled : input.enabled;
        if (enabled && !token) return { ok: false, reason: "telegram_token_required" };
        let identity;
        if (suppliedToken) {
          try { identity = await TelegramBot.testToken(token, this.engineOptions.telegramTransport || null); }
          catch (error) { return { ok: false, reason: error.code || "telegram_unavailable" }; }
        }
        const tokenChanged = Boolean(old.token && token !== old.token);
        if (tokenChanged && this.telegramBot) await this.telegramBot.stop();
        this.telegramStore.update((config) => {
          if (config.token !== token) config.lastUpdateId = null;
          if (tokenChanged) {
            config.admins = [];
            config.users = [];
            config.requests = [];
            config.pairing = null;
            config.confirmations = [];
            config.outbox = [];
            config.deadLetters = [];
            config.lastError = null;
          }
          config.token = token;
          config.enabled = enabled;
          if (identity) config.botUsername = identity.username;
        });
        await this._syncTelegram();
        return { ok: true, enabled, botName: this.telegramStore.read().botUsername || null };
      }
      case "telegramPair": {
        let code = null;
        let expiresAt = null;
        this.telegramStore.update((config) => {
          if (!config.enabled || !config.token || config.admins.length) return;
          const crypto = require("crypto");
          code = crypto.randomBytes(6).toString("hex").toUpperCase();
          expiresAt = Date.now() + 10 * 60_000;
          config.pairing = { hash: crypto.createHash("sha256").update(code).digest("hex"), expiresAt };
        });
        if (code) return { ok: true, code, expiresAt };
        const config = this.telegramStore.read();
        return { ok: false, reason: !config.enabled || !config.token ? "telegram_not_enabled" : "telegram_root_already_paired" };
      }
      case "telegramTest": {
        const config = this.telegramStore.read();
        if (!config.enabled || !config.token) return { ok: false, reason: "telegram_not_enabled" };
        if (!config.admins[0]) return { ok: false, reason: "telegram_admin_not_paired" };
        try {
          const identity = await TelegramBot.testMessage(config.token, config.admins[0], this.engineOptions.telegramTransport || null);
          return { ok: true, botName: identity.username };
        } catch (error) { return { ok: false, reason: error.code || "telegram_unavailable" }; }
      }
      case "telegramDisconnect": {
        if (this.telegramBot) await this.telegramBot.stop();
        this.telegramStore.update((config) => {
          config.token = "";
          config.enabled = false;
          config.botUsername = "";
          config.admins = [];
          config.users = [];
          config.requests = [];
          config.pairing = null;
          config.confirmations = [];
          config.outbox = [];
          config.deadLetters = [];
          config.lastUpdateId = null;
          config.lastError = null;
        });
        return { ok: true, disconnected: true };
      }
      default: throw fault("unknown_method");
    }
  }

  async _syncTelegram() {
    if (!this.telegramContext.active || !this.telegramBot) return;
    await this.telegramBot.sync();
  }
}

module.exports = { ExecutionHost, atomicJson, fault };
