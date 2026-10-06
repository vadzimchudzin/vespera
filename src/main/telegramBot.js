"use strict";

const https = require("https");
const crypto = require("crypto");

const REQUEST_TIMEOUT_MS = 12_000;
const LONG_POLL_SECONDS = 8;
const MAX_OUTBOX = 1000;
const CONFIRMATION_TTL_MS = 60_000;
const LIVE_SETTINGS = new Set([
  "baseUsd", "maxSteps", "sizingMode", "fixedStakes", "maxStakeUsd", "maxSeriesLossUsd",
  "dailyLossLimitUsd", "maxEntryPrice", "minOpeningAtr", "minCrossTicks", "confirmCount",
  "fastPeriod", "slowPeriod", "maType",
]);

class TelegramError extends Error {
  constructor(code, { status = 0, retryAfter = 0, permanent = false } = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.permanent = permanent;
  }
}

function telegramApi(token, method, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS, transport = null, signal = null) {
  if (transport) return Promise.resolve(transport(method, payload, timeoutMs, signal));
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = https.request({
      hostname: "api.telegram.org",
      method: "POST",
      path: `/bot${token}/${method}`,
      headers: { "content-type": "application/json", "content-length": body.length },
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new TelegramError("telegram_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new TelegramError("telegram_invalid_response", { status: response.statusCode || 0 })); }
        if (response.statusCode === 429 || result.error_code === 429) {
          return reject(new TelegramError("telegram_rate_limited", {
            status: 429,
            retryAfter: Math.max(1, Number(result.parameters?.retry_after) || 1),
          }));
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || !result.ok) {
          const status = response.statusCode || Number(result.error_code) || 0;
          return reject(new TelegramError("telegram_api_rejected", { status, permanent: status >= 400 && status < 500 }));
        }
        resolve(result.result);
      });
    });
    request.on("timeout", () => request.destroy(new TelegramError("telegram_timeout")));
    request.on("error", (error) => reject(error instanceof TelegramError ? error : new TelegramError("telegram_network_error")));
    request.end(body);
  });
}

function validateToken(token) {
  return typeof token === "string" && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
}

function addOutbox(store, chatId, text, keyboard = undefined) {
  if (!chatId || typeof text !== "string" || !text) return false;
  let accepted = false;
  try {
    store.update((config) => {
      if (config.outbox.length >= MAX_OUTBOX) {
        config.lastError = "telegram_outbox_full";
        return;
      }
      config.outbox.push({
        id: crypto.randomUUID(),
        chatId: String(chatId),
        text: text.slice(0, 3900),
        ...(keyboard ? { keyboard } : {}),
        attempts: 0,
        nextAt: Date.now(),
      });
      accepted = true;
    });
  } catch {
    try { store.update((config) => { config.lastError = "telegram_storage_unavailable"; }); } catch { /* delivery storage never interrupts execution */ }
  }
  return accepted;
}

function privateIdentity(update) {
  const message = update.message || update.edited_message;
  const user = message?.from;
  const chat = message?.chat;
  if (!user || !chat || chat.type !== "private" || String(chat.id) !== String(user.id)) return null;
  if (!/^\d{1,20}$/.test(String(user.id))) return null;
  return { userId: String(user.id), chatId: String(chat.id), text: String(message.text || "").trim() };
}

function parseSetting(value) {
  const text = value.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/[,;\n]/.test(text)) return text.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
  const number = Number(text);
  return text && Number.isFinite(number) ? number : text;
}

class TelegramBot {
  constructor({ store, host, getOwner, serialize = (fn) => fn(), transport = null, now = Date.now, command = null }) {
    this.store = store;
    this.host = host;
    this.getOwner = getOwner;
    this.serialize = serialize;
    this.transport = transport;
    this.now = now;
    this.command = command;
    this.stopped = true;
    this.loopPromise = null;
    this.outboxTimer = null;
    this.waitTimer = null;
    this.wakeWait = null;
    this.pollController = null;
    this.outboxController = null;
    this.flushing = false;
    this.activeToken = null;
    this.generation = 0;
  }

  static async testToken(token, transport = null) {
    if (!validateToken(token)) throw new TelegramError("telegram_token_invalid", { permanent: true });
    const result = await telegramApi(token, "getMe", {}, REQUEST_TIMEOUT_MS, transport);
    if (!result || !Number.isInteger(result.id) || typeof result.username !== "string") throw new TelegramError("telegram_identity_invalid");
    return { id: String(result.id), username: result.username };
  }

  static async testMessage(token, chatId, transport = null) {
    if (!validateToken(token)) throw new TelegramError("telegram_token_invalid", { permanent: true });
    const identity = await TelegramBot.testToken(token, transport);
    await telegramApi(token, "sendMessage", { chat_id: chatId, text: "Vespera Telegram test message: delivery is working." }, REQUEST_TIMEOUT_MS, transport);
    return identity;
  }

  start() {
    const config = this._config();
    if (!config.enabled || !config.token || !this.stopped) return;
    this.stopped = false;
    this.activeToken = config.token;
    const generation = ++this.generation;
    this.loopPromise = this._pollLoop(generation);
    this.outboxTimer = setInterval(() => this.flushOutbox().catch(() => {}), 1000);
    this.outboxTimer.unref?.();
    this.flushOutbox().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.pollController?.abort();
    this.outboxController?.abort();
    clearTimeout(this.waitTimer);
    this.wakeWait?.();
    this.waitTimer = null;
    this.wakeWait = null;
    clearInterval(this.outboxTimer);
    this.outboxTimer = null;
    this.loopPromise = null;
    this.activeToken = null;
  }

  async sync() {
    const config = this._config();
    if (config.enabled && config.token) {
      if (!this.stopped && this.activeToken !== config.token) await this.stop();
      this.start();
    } else if (!this.stopped) await this.stop();
  }

  status() {
    const config = this._config();
    return { enabled: Boolean(config.enabled), connected: Boolean(config.enabled && config.token && !this.stopped),
      deadLetterCount: (config.deadLetters || []).length, lastError: config.lastError || null };
  }

  _config() { return this.store.read(); }

  _isCurrent(generation) { return !this.stopped && generation === this.generation; }

  async _pollLoop(generation) {
    while (this._isCurrent(generation)) {
      let controller;
      try {
        const config = this._config();
        if (!config.enabled || !config.token) {
          await this._wait(1000, generation);
          continue;
        }
        controller = new AbortController();
        this.pollController = controller;
        const updates = await telegramApi(config.token, "getUpdates", {
          ...(Number.isInteger(config.lastUpdateId) ? { offset: config.lastUpdateId + 1 } : {}),
          timeout: LONG_POLL_SECONDS,
          allowed_updates: ["message", "callback_query"],
        }, (LONG_POLL_SECONDS + 4) * 1000, this.transport, controller.signal);
        if (this.pollController === controller) this.pollController = null;
        if (!this._isCurrent(generation)) break;
        if (!Array.isArray(updates)) throw new TelegramError("telegram_updates_invalid");
        for (const update of updates) {
          if (!this._isCurrent(generation)) break;
          try { await this.processUpdate(update, generation); } catch (error) { if (this._isCurrent(generation)) this._setLastError(error); }
        }
      } catch (error) {
        if (this.pollController === controller) this.pollController = null;
        if (this._isCurrent(generation)) this._setLastError(error);
        if (this._isCurrent(generation)) await this._wait(error.retryAfter ? error.retryAfter * 1000 : 1500, generation);
      }
    }
  }

  _wait(ms, generation) {
    let wake;
    let timer;
    return new Promise((resolve) => {
      wake = resolve;
      this.wakeWait = resolve;
      timer = setTimeout(resolve, ms);
      this.waitTimer = timer;
      timer.unref?.();
    }).finally(() => {
      if (this.wakeWait === wake) this.wakeWait = null;
      if (this.waitTimer === timer) this.waitTimer = null;
    });
  }

  async processUpdate(update, generation = null) {
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return false;
    if (!this._config().enabled) return false;
    const claimed = this.store.update((config) => {
      if (Number.isSafeInteger(config.lastUpdateId) && update.update_id <= config.lastUpdateId) return false;
      config.lastUpdateId = update.update_id;
      return true;
    });
    if (!claimed) return false;
    await this.serialize(async () => {
      if (generation != null && !this._isCurrent(generation)) return;
      if (!this._config().enabled) return;
      const callback = update.callback_query;
      const privateMessage = privateIdentity(update);
      if (callback) return this._callback(callback);
      if (privateMessage) return this._message(privateMessage);
      const message = update.message || update.edited_message;
      if (message?.chat?.type === "private" && message?.from?.id && message.chat.id === message.from.id) return;
    });
    return true;
  }

  _setLastError(error) {
    const code = /^[a-z0-9_:-]{1,80}$/i.test(error?.code || "") ? error.code : "telegram_unavailable";
    try { this.store.update((config) => { config.lastError = code; }); } catch { /* Telegram errors cannot stop execution */ }
  }

  async _reply(chatId, text, keyboard) {
    return addOutbox(this.store, chatId, this._safeText(text), keyboard);
  }

  _safeText(value) {
    let text = String(value ?? "");
    const settings = this.host?.engine?.settings || {};
    for (const key of ["apiKey", "apiSecret", "apiPassphrase", "privateKey", "proxyUrl"]) {
      const secret = settings[key];
      if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
    }
    try {
      const token = this._config().token;
      if (token) text = text.split(token).join("[redacted]");
    } catch { /* fail closed when formatting Telegram output */ }
    return text
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
      .replace(/\b0x[a-f0-9]{64}\b/gi, "[redacted-key]");
  }

  _root(config) { return config.admins[0] || null; }

  _approved(config, userId) { return this._root(config) === userId || config.users.includes(userId); }

  _ownerSnapshot() {
    const owner = this.getOwner?.() || {};
    return { owner: owner.owner || null, active: owner.active === true, epoch: Number.isInteger(owner.epoch) ? owner.epoch : null };
  }

  _hasOwner() {
    const owner = this._ownerSnapshot();
    return owner.owner === "server" || (owner.owner === "local" && owner.active);
  }

  _call(method, args = []) {
    return this.command ? this.command(method, args) : this.host.call(method, args);
  }

  _riskFingerprint(state) {
    const settings = state.settings || {};
    const fields = ["dryRun", "baseUsd", "maxSteps", "sizingMode", "fixedStakes", "maxStakeUsd", "maxSeriesLossUsd", "dailyLossLimitUsd", "maxEntryPrice", "minOpeningAtr", "minCrossTicks", "confirmCount", "fastPeriod", "slowPeriod", "maType", "strategyId", "symbol", "timeframe"];
    const values = Object.fromEntries(fields.map((key) => [key, settings[key] ?? state[key] ?? null]));
    values.mode = state.mode;
    values.risk = state.risk ? {
      step: state.risk.step,
      seriesLossUsd: state.risk.seriesLossUsd,
      halted: state.risk.halted,
    } : null;
    return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }

  _menuKeyboard(userId) {
    const locale = this.host?.engine?.settings?.locale || this.host?.store?.value?.locale || "en";
    const ru = locale === "ru";
    const button = (label, action) => ({ text: label, callback_data: `action:${action}` });
    const rows = [
      [button(ru ? "Статус" : "Status", "status"), button(ru ? "Баланс" : "Balance", "balance")],
      [button(ru ? "Старт" : "Start", "start"), button(ru ? "Стоп" : "Stop", "stop")],
      [button(ru ? "Новая серия" : "New series", "new"), button(ru ? "Стратегия" : "Strategy", "strategy")],
      [button(ru ? "Настройки" : "Settings", "settings"), ...(this._root(this._config()) === userId ? [button(ru ? "Админка" : "Admin", "admin")] : [])],
    ];
    return rows;
  }

  async _message({ userId, chatId, text }) {
    const config = this._config();
    const [command = "", ...params] = text.split(/\s+/);
    const name = command.toLowerCase().split("@")[0];
    if (name === "/pair") return this._pair(userId, chatId, params[0] || "");
    if (name === "/access" || name === "/startbot") return this._requestAccess(userId, chatId);
    const isRoot = this._root(config) === userId;
    const approved = isRoot || config.users.includes(userId);
    if (!approved) return this._reply(chatId, "Access is not approved. Request access to use the shared trading book.", [[{ text: "Request access", callback_data: "access" }]]);
    if (name === "/requests" || name === "/approve" || name === "/deny" || name === "/admins" || name === "/revoke") {
      if (!isRoot) return this._reply(chatId, "Only the root administrator can manage access.");
      return this._adminCommand(name, params, chatId, config);
    }
    if (name === "/status") return this._status(chatId);
    if (name === "/balance") return this._status(chatId, true);
    if (name === "/menu" || name === "/help") return this._reply(chatId, "Choose a control. Trading actions still follow execution ownership and risk checks.", this._menuKeyboard(userId));
    if (name === "/start") return this._start(chatId, userId);
    if (name === "/stop") return this._stop(chatId);
    if (name === "/new") return this._newSeries(chatId, userId);
    if (name === "/mode") return this._mode(chatId, params[0]);
    if (name === "/strategy") return this._strategy(chatId, params[0]);
    if (name === "/settings") return this._settings(chatId, params);
    return this._reply(chatId, "Commands: /menu /status /balance /start /stop /new /mode paper|auto /strategy [id] /settings field=value");
  }

  async _pair(userId, chatId, code) {
    let paired = false;
    try {
      this.store.update((config) => {
        const digest = crypto.createHash("sha256").update(String(code)).digest("hex");
        const pair = config.pairing;
        if (!config.token || config.admins.length || !pair || pair.expiresAt <= this.now() || pair.hash !== digest) return;
        config.admins = [userId];
        config.pairing = null;
        paired = true;
      });
    } catch { return this._reply(chatId, "Pairing is unavailable; ask the desktop app to create a new code."); }
    if (paired) return this._reply(chatId, "You are now the root administrator. Use the menu below to control the shared book.", this._menuKeyboard(userId));
    await this._reply(chatId, "Pairing code is invalid, expired, or already used.");
  }

  async _requestAccess(userId, chatId) {
    let requested = false;
    let newlyRequested = false;
    let root = null;
    this.store.update((config) => {
      root = this._root(config);
      if (!root || root === userId || config.users.includes(userId)) return;
      if (!config.requests.some((row) => row.userId === userId)) {
        config.requests.push({ userId, requestedAt: this.now() });
        newlyRequested = true;
      }
      requested = true;
    });
    if (!root) return this._reply(chatId, "No root administrator is paired yet. Use the one-time code from the desktop app with /pair CODE.");
    if (!requested) return this._reply(chatId, "This account already has access or has a pending request.");
    await this._reply(chatId, "Access request sent to the root administrator.");
    if (!newlyRequested) return;
    await this._reply(root, `Access requested by Telegram user ${userId}.`, [[
      { text: "Approve", callback_data: `approve:${userId}` },
      { text: "Deny", callback_data: `deny:${userId}` },
    ]]);
  }

  async _adminCommand(name, params, chatId, config) {
    const userId = params[0] || "";
    if (name === "/requests") {
      return this._reply(chatId, config.requests.length ? `Pending requests: ${config.requests.map((r) => r.userId).join(", ")}` : "No pending access requests.");
    }
    if (name === "/admins") return this._reply(chatId, `Root administrator: ${this._root(config) || "none"}\nApproved users: ${config.users.join(", ") || "none"}`, config.users.map((id) => [{ text: `Revoke ${id}`, callback_data: `revoke:${id}` }]));
    if (!/^\d{1,20}$/.test(userId)) return this._reply(chatId, `Usage: ${name} TELEGRAM_USER_ID`);
    if (name === "/revoke") {
      if (userId === this._root(config)) return this._reply(chatId, "The root administrator cannot be revoked here.");
      this.store.update((state) => {
        state.users = state.users.filter((id) => id !== userId);
        state.requests = state.requests.filter((r) => r.userId !== userId);
        state.confirmations = state.confirmations.filter((row) => row.userId !== userId);
        state.outbox = state.outbox.filter((row) => row.chatId !== userId);
        state.deadLetters = (state.deadLetters || []).filter((row) => row.chatId !== userId);
        if (!state.deadLetters.length && /^telegram_delivery_permanent_/.test(state.lastError || "")) state.lastError = null;
      });
      return this._reply(chatId, `Access revoked for ${userId}.`);
    }
    const approved = name === "/approve";
    if (!config.requests.some((row) => row.userId === userId)) return this._reply(chatId, "No pending request exists for that user.");
    this.store.update((state) => {
      state.requests = state.requests.filter((row) => row.userId !== userId);
      if (approved && userId !== this._root(state) && !state.users.includes(userId)) state.users.push(userId);
    });
    return this._reply(chatId, approved ? `Approved ${userId}.` : `Denied ${userId}.`);
  }

  async _callback(callback) {
    const userId = String(callback.from?.id || "");
    const chatId = String(callback.message?.chat?.id || "");
    const callbackId = String(callback.id || "");
    const data = typeof callback.data === "string" ? callback.data : "";
    if (callback.message?.chat?.type !== "private" || !/^\d{1,20}$/.test(userId) || !/^\d{1,20}$/.test(chatId) || chatId !== userId) return;
    const config = this._config();
    if (data === "access") return this._requestAccess(userId, chatId);
    if (!this._approved(config, userId)) return this._reply(chatId, "Access is not approved. Use the access-request button in a private chat.");
    const root = this._root(config);
    if (data.startsWith("strategy:")) return this._strategy(chatId, data.slice(9));
    if (/^mode:(paper|auto)$/.test(data)) return this._mode(chatId, data.slice(5));
    if (/^revoke:\d{1,20}$/.test(data)) {
      if (root !== userId) return this._reply(chatId, "Only the root administrator can manage access.");
      return this._adminCommand("/revoke", [data.slice(7)], chatId, config);
    }
    if (data.startsWith("approve:") || data.startsWith("deny:")) {
      if (root !== userId) return this._reply(chatId, "Only the root administrator can manage access.");
      const [action, target] = data.split(":");
      if (!/^\d{1,20}$/.test(target || "")) return;
      await this._adminCommand(action === "approve" ? "/approve" : "/deny", [target], chatId, config);
      return;
    }
    const actionMatch = /^action:(status|balance|start|stop|new|strategy|settings|admin|requests|users)$/.exec(data);
    if (actionMatch) {
      const action = actionMatch[1];
      if (["admin", "requests", "users"].includes(action) && root !== userId) return this._reply(chatId, "Only the root administrator can manage access.");
      if (action === "status") return this._status(chatId);
      if (action === "balance") return this._status(chatId, true);
      if (action === "start") return this._start(chatId, userId);
      if (action === "stop") return this._stop(chatId);
      if (action === "new") return this._newSeries(chatId, userId);
      if (action === "strategy") return this._strategy(chatId);
      if (action === "settings") return this._settings(chatId, []);
      if (action === "admin") return this._reply(chatId, "Administrator tools", [
        [{ text: "Requests", callback_data: "action:requests" }, { text: "Approved users", callback_data: "action:users" }],
        [{ text: "Status", callback_data: "action:status" }],
      ]);
      if (action === "requests") return this._adminCommand("/requests", [], chatId, config);
      return this._adminCommand("/admins", [], chatId, config);
    }
    const match = /^confirm:([a-f0-9]{24})$/.exec(data);
    if (!match) return;
    if (!this._hasOwner()) return this._serverOnly(chatId);
    const owner = this._ownerSnapshot();
    let snapshot;
    try { snapshot = await this._call("snapshot"); }
    catch { return this._reply(chatId, "Confirmation could not be checked; request a new one."); }
    let confirmation = null;
    this.store.update((state) => {
      if (!this._approved(state, userId)) return;
      const index = state.confirmations.findIndex((row) => row.id === match[1] && row.userId === userId && row.expiresAt > this.now());
      if (index < 0) return;
      const row = state.confirmations[index];
      const currentOwner = this._ownerSnapshot();
      if (row.owner !== owner.owner || row.ownerEpoch !== owner.epoch || row.ownerActive !== owner.active ||
          currentOwner.owner !== owner.owner || currentOwner.epoch !== owner.epoch || currentOwner.active !== owner.active ||
          row.fingerprint !== this._riskFingerprint(snapshot)) return;
      if (snapshot.running || snapshot.liveBet || snapshot.paper?.openBet || snapshot.orderPending) return;
      if (row.action === "live_start" && (snapshot.mode !== "auto" || snapshot.settings?.dryRun !== false || snapshot.risk?.halted)) return;
      confirmation = row;
      state.confirmations.splice(index, 1);
    });
    if (!confirmation) return this._reply(chatId, "Confirmation expired, settings changed, access was revoked, or execution is no longer safe. Request a new confirmation.");
    await this._control(chatId, confirmation.action, confirmation);
    if (callbackId) {
      try { await telegramApi(this._config().token, "answerCallbackQuery", { callback_query_id: callbackId }, REQUEST_TIMEOUT_MS, this.transport); } catch { /* not part of command success */ }
    }
  }

  _requireServer() {
    return this._hasOwner();
  }

  async _serverOnly(chatId) {
    await this._reply(chatId, "Trading control is available only while the server or desktop is the active execution owner. Telegram never takes over a standby engine.");
    return false;
  }

  async _status(chatId, balanceOnly = false) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    const state = await this._call("snapshot");
    const balance = state.mode === "paper" || state.settings?.dryRun
      ? state.paper?.balance
      : state.liveBalance?.value;
    const open = state.liveBet || state.paper?.openBet;
    const text = [
      `Execution: ${this._ownerSnapshot().owner === "local" ? "desktop" : "server"} · ${state.status || "unknown"} · ${state.running ? "running" : "stopped"}`,
      `Mode: ${state.mode}${state.settings?.dryRun && state.mode === "auto" ? " (dry run)" : ""}`,
      `Strategy: ${state.strategyName || state.strategyId || "unknown"}`,
      `Balance: ${balance == null ? "unavailable" : `$${balance}`}`,
      `Series: step ${state.risk?.step ?? "?"}/${state.risk?.maxSteps ?? "?"} · loss $${state.risk?.seriesLossUsd ?? "?"}`,
      `Position: ${open ? `${open.side || "?"} $${open.sizeUsd || "?"}` : "none"}`,
      `Pause: ${state.pauseReason || (state.risk?.halted ? "risk halt" : "none")}`,
    ].join("\n");
    if (balanceOnly) return this._reply(chatId, `Balance: ${balance == null ? "unavailable" : `$${balance}`} · ${state.mode}${state.settings?.dryRun && state.mode === "auto" ? " (dry run)" : ""}`);
    return this._reply(chatId, text);
  }

  async _start(chatId, userId) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    const state = await this._call("snapshot");
    if (state.running) return this._reply(chatId, "Trading is already running.");
    if (state.liveBet || state.paper?.openBet || state.orderPending) return this._reply(chatId, "Start refused while a position or order is unresolved.");
    if (state.risk?.halted) return this._reply(chatId, "Start refused by the risk halt. Reconcile any unknown order or use New series only when the engine permits it.");
    if (state.mode === "auto" && !state.settings?.dryRun) {
      const id = crypto.randomBytes(12).toString("hex");
      const owner = this._ownerSnapshot();
      this.store.update((config) => {
        config.confirmations = config.confirmations.filter((row) => row.expiresAt > this.now()).slice(-19);
        config.confirmations.push({ id, userId, action: "live_start", expiresAt: this.now() + CONFIRMATION_TTL_MS,
          owner: owner.owner, ownerEpoch: owner.epoch, ownerActive: owner.active, fingerprint: this._riskFingerprint(state) });
      });
      return this._reply(chatId, `Real-money start requested for ${state.strategyName || state.strategyId || "current strategy"} · base stake $${state.settings?.baseUsd ?? "?"} · max stake $${state.settings?.maxStakeUsd ?? "unlimited"}. Confirm within 60 seconds.`, [[{ text: "Confirm LIVE start", callback_data: `confirm:${id}` }]]);
    }
    return this._control(chatId, "paper_start");
  }

  async _stop(chatId) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    const state = await this._call("stop");
    this.host.setTelegramDesiredRunning?.(false);
    return this._reply(chatId, `Stopped. Current status: ${state.status || "stopped"}.`);
  }

  async _newSeries(chatId, userId) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    const state = await this._call("snapshot");
    if (state.running || state.liveBet || state.paper?.openBet || state.orderPending) return this._reply(chatId, "Stop trading and finish or reconcile any open position/order before starting a new series.");
    const id = crypto.randomBytes(12).toString("hex");
    const owner = this._ownerSnapshot();
    this.store.update((config) => {
      config.confirmations = config.confirmations.filter((row) => row.expiresAt > this.now()).slice(-19);
      config.confirmations.push({ id, userId, action: "new_series", expiresAt: this.now() + CONFIRMATION_TTL_MS,
        owner: owner.owner, ownerEpoch: owner.epoch, ownerActive: owner.active, fingerprint: this._riskFingerprint(state) });
    });
    return this._reply(chatId, "A new series resets the current loss progression; daily losses and unknown-order locks remain. Confirm within 60 seconds.", [[{ text: "Confirm new series", callback_data: `confirm:${id}` }]]);
  }

  async _mode(chatId, value) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    if (!value || !["paper", "auto"].includes(value.toLowerCase())) return this._reply(chatId, "Usage: /mode paper|auto. Selecting Auto does not start trading.");
    try {
      const state = await this._call("setMode", [value.toLowerCase()]);
      return this._reply(chatId, `Mode selected: ${state.mode}. Trading was not started.`);
    } catch (error) { return this._reply(chatId, `Mode unchanged: ${error.code || "settings_locked"}.`); }
  }

  async _strategy(chatId, id) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    const state = await this._call("snapshot");
    if (!id) return this._reply(chatId, `Strategy: ${state.strategyId}\nAvailable: ${(state.strategies || []).map((item) => item.id).join(", ")}`, (state.strategies || []).filter((item) => typeof item.id === "string" && Buffer.byteLength(`strategy:${item.id}`) <= 64).map((item) => [{ text: item.name || item.id, callback_data: `strategy:${item.id}` }]));
    if (!(state.strategies || []).some((item) => item.id === id)) return this._reply(chatId, "Unknown strategy. Use /strategy to list available strategies.");
    try {
      const result = await this._call("setStrategy", [id]);
      return this._reply(chatId, `Strategy selected: ${result.strategyId || id}.`);
    } catch (error) { return this._reply(chatId, `Strategy unchanged: ${error.code || "settings_locked"}.`); }
  }

  async _settings(chatId, params) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    if (!params.length) return this._reply(chatId, `Editable: ${[...LIVE_SETTINGS].join(", ")}. Format: /settings field=value`, [[{ text: "Paper", callback_data: "mode:paper" }, { text: "Auto", callback_data: "mode:auto" }]]);
    const patch = {};
    for (const item of params) {
      const split = item.indexOf("=");
      if (split < 1) return this._reply(chatId, "Use field=value for each setting.");
      const field = item.slice(0, split);
      if (!LIVE_SETTINGS.has(field)) return this._reply(chatId, `Setting is not remotely editable: ${field}.`);
      patch[field] = parseSetting(item.slice(split + 1));
    }
    const { normalizeSettings } = require("../shared/settings");
    try {
      const snapshot = await this._call("snapshot");
      const validated = normalizeSettings(patch, snapshot.settings, { strict: true });
      const result = await this._call("saveSettings", [validated]);
      if (result?.ok === false) throw Object.assign(new Error(result.reason || "invalid_settings"), { code: result.reason || "invalid_settings", field: result.field });
      return this._reply(chatId, "Settings saved using the shared strict validator. Existing position/series locks still apply.");
    } catch (error) { return this._reply(chatId, `Settings unchanged: ${error.code || "invalid_settings"}${error.field ? ` (${error.field})` : ""}.`); }
  }

  async _control(chatId, action) {
    if (!this._requireServer()) return this._serverOnly(chatId);
    try {
      if (action === "paper_start" || action === "live_start") {
        const result = await this._call("start", [{ confirmLive: action === "live_start" }]);
        if (result?.ok) {
          this.host.setTelegramDesiredRunning?.(true);
          return this._reply(chatId, "Trading start accepted. Check /status for the current state.");
        }
        return this._reply(chatId, `Start refused: ${result?.reason || "engine_refused"}.`);
      }
      if (action === "new_series") {
        const snapshot = await this._call("snapshot");
        if (snapshot.running || snapshot.liveBet || snapshot.paper?.openBet || snapshot.orderPending) return this._reply(chatId, "New series refused: trading is active or a position/order is unresolved.");
        await this._call("confirmLot", [snapshot.settings.baseUsd, { resetSeries: true }]);
        return this._reply(chatId, "New series confirmed. Daily loss totals and unknown-order protections were preserved.");
      }
    } catch (error) {
      return this._reply(chatId, `Action refused: ${error.code || "engine_error"}.`);
    }
  }

  enqueueEvent(event) {
    if (!event || !["signal", "order", "settled", "halt", "status"].includes(event.type)) return;
    const config = this._config();
    if (!config.enabled || !this._hasOwner()) return;
    const recipients = [...new Set([...config.admins, ...config.users])];
    if (!recipients.length) return;
    let text = null;
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (event.type === "signal") text = `Opening signal: ${payload.signal || payload.side || "?"} · $${payload.size ?? "?"}${payload.paper ? " · Paper" : ""}`;
    if (event.type === "order") text = `Order update: ${payload.side || "?"} · $${payload.sizeUsd || "?"} · ${payload.status || payload.orderStatus || "unknown status"}${payload.price ? ` @ ${payload.price}` : ""}${payload.feeUsd ? ` · fee $${payload.feeUsd}` : ""}`;
    if (event.type === "settled") text = `Settlement: ${payload.side || "?"} · ${payload.status || "unknown"} · net P&L $${payload.pnl ?? payload.netPnl ?? "?"} · fee $${payload.feeUsd ?? "?"}`;
    if (event.type === "halt") text = `Risk halt: ${payload.reason || "execution halted"}. Review the desktop/server state; Telegram cannot clear safety locks.`;
    if (event.type === "status" && ["paused", "halt", "daily_limit", "stopped"].includes(typeof event.payload === "string" ? event.payload : payload.status)) {
      text = `Execution status: ${typeof event.payload === "string" ? event.payload : payload.status || "changed"}${payload.pauseReason ? ` · ${payload.pauseReason}` : ""}`;
    }
    if (text) for (const recipient of recipients) this._reply(recipient, text);
  }

  notifyDesktop(connected) {
    try {
      let changed = false;
      this.store.update((config) => {
        if (config.desktopConnected === connected) return;
        config.desktopConnected = connected;
        changed = true;
      });
      if (changed) {
        const root = this._root(this._config());
        if (root) addOutbox(this.store, root, connected ? "Desktop heartbeat restored. Server remains the execution owner." : "Desktop heartbeat lost. Server execution remains unchanged; Telegram will not take over the desktop.");
      }
    } catch { /* Telegram storage failure must not affect heartbeat ownership */ }
  }

  async flushOutbox() {
    if (this.flushing) return;
    const config = this._config();
    if (!config.enabled || !config.token || !config.outbox.length) return;
    const job = config.outbox.find((item) => item.nextAt <= this.now());
    if (!job) return;
    this.flushing = true;
    this.outboxController = new AbortController();
    try {
      await telegramApi(config.token, "sendMessage", {
        chat_id: job.chatId,
        text: job.text,
        ...(job.keyboard ? { reply_markup: { inline_keyboard: job.keyboard } } : {}),
      }, REQUEST_TIMEOUT_MS, this.transport, this.outboxController.signal);
      this.store.update((state) => {
        state.outbox = state.outbox.filter((item) => item.id !== job.id);
        if (!(state.deadLetters || []).length) state.lastError = null;
      });
    } catch (error) {
      this.store.update((state) => {
        const current = state.outbox.find((item) => item.id === job.id);
        if (!current) return;
        if (error.permanent || (error.status >= 400 && error.status < 500 && error.status !== 429)) {
          state.outbox = state.outbox.filter((item) => item.id !== job.id);
          state.deadLetters = (state.deadLetters || []).filter((item) => item.id !== job.id);
          state.deadLetters.push({ id: job.id, chatId: job.chatId, error: error.code || `telegram_delivery_${error.status || "rejected"}`, failedAt: this.now() });
          state.deadLetters = state.deadLetters.slice(-100);
          state.lastError = `telegram_delivery_permanent_${error.status || "rejected"}`;
          return;
        }
        current.attempts = (current.attempts || 0) + 1;
        const backoff = error.retryAfter ? error.retryAfter * 1000 : Math.min(60 * 60_000, 1000 * (2 ** Math.min(current.attempts, 12)));
        current.nextAt = this.now() + backoff;
        state.lastError = error.code || "telegram_delivery_unavailable";
      });
    } finally {
      this.flushing = false;
      this.outboxController = null;
    }
  }
}

module.exports = { TelegramBot, TelegramError, telegramApi, validateToken, addOutbox, LIVE_SETTINGS, REQUEST_TIMEOUT_MS };
