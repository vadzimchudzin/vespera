"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { SettingsStore } = require("../main/settingsStore");

const PROTOCOL = 1;
const MAX_BODY = 1024 * 1024;
const MAX_BUNDLE = 16 * 1024 * 1024;
const MAX_EVENTS = 1000;
const METHODS = new Set([
  "snapshot", "warmChart", "start", "stop", "setMode", "confirmLot", "ping", "connect", "testOrder",
  "deriveKeys", "setStrategy", "resetPaper", "getSettings", "saveSettings", "exportCsv", "depositAssets",
  "depositAddress", "depositStatus",
]);
const SECRET_KEYS = /^(api.?key|api.?secret|api.?passphrase|private.?key|proxy.?url|server.?token|token|authorization|credentials|bundle)$/i;

class ServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function atomicJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  try {
    const directory = fs.openSync(dir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function syncFileAndDirectory(file) {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = path.dirname(file);
  try {
    const dirFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the user */ }
}

function acquireLock(dir) {
  const lockDir = path.join(dir, ".service.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      atomicJson(path.join(lockDir, "owner.json"), { pid: process.pid });
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* process is exiting */ } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch { owner = null; }
      if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("service_lock_unreadable");
      try { process.kill(owner.pid, 0); throw new Error("service_already_running"); } catch (probe) {
        if (probe.message === "service_already_running") throw probe;
        if (probe.code !== "ESRCH") throw new Error("service_lock_unverified");
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error("service_lock_unavailable");
}

function clean(value, depth = 0, redactions = []) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(-5000).map((item) => clean(item, depth + 1, redactions));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      let text = value.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      for (const secret of redactions) if (secret.length >= 4) text = text.split(secret).join("[redacted]");
      return text.replace(/\b0x[a-f0-9]{64}\b/gi, "[redacted-key]").slice(0, 8192);
    }
    return value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue;
    result[key] = clean(item, depth + 1, redactions);
  }
  return result;
}

function createService({ userDataDir, token, host, hostFactory, now = Date.now } = {}) {
  if (!userDataDir) throw new TypeError("userDataDir is required");
  if (typeof token !== "string" || Buffer.byteLength(token) < 32 || /\s/.test(token)) throw new TypeError("token must contain at least 32 bytes and no whitespace");
  privateDir(userDataDir);
  const ownershipFile = path.join(userDataDir, "ownership.json");
  const ledgerDir = path.join(userDataDir, "request-ledger");
  const legacyLedgerFile = path.join(userDataDir, "request-ledger.json");
  const releaseStore = new SettingsStore(path.join(userDataDir, "handoff-private"));
  let releaseLock = acquireLock(userDataDir);
  let owner;
  let legacyLedger = [];
  let releaseCache = null;
  try {
    if (fs.existsSync(ownershipFile)) {
      owner = JSON.parse(fs.readFileSync(ownershipFile, "utf8"));
      if (!owner || !["local", "server"].includes(owner.owner) || !Number.isInteger(owner.epoch) || owner.epoch < 0 ||
          (owner.protocol != null && owner.protocol !== PROTOCOL) || typeof owner.desiredRunning !== "boolean" ||
          (owner.lastSeenAt != null && !Number.isFinite(owner.lastSeenAt))) throw new Error("invalid_ownership");
    } else {
      owner = { protocol: PROTOCOL, owner: "local", deviceId: null, epoch: 0, desiredRunning: false, lastSeenAt: null, activationRequestId: null, registrationRequestId: null };
    }
    if (fs.existsSync(legacyLedgerFile)) {
      legacyLedger = JSON.parse(fs.readFileSync(legacyLedgerFile, "utf8"));
      if (!Array.isArray(legacyLedger) || legacyLedger.some((row) => !row || typeof row.id !== "string" || !["pending", "done"].includes(row.state))) throw new Error("invalid_request_ledger");
    }
    const oldReleaseFile = path.join(userDataDir, "release-cache.json");
    if (fs.existsSync(oldReleaseFile)) {
      const oldRelease = JSON.parse(fs.readFileSync(oldReleaseFile, "utf8"));
      if (!oldRelease || typeof oldRelease.requestId !== "string" || !oldRelease.bundle) throw new Error("invalid_release_cache");
      releaseStore.save({ transferBundle: JSON.stringify(oldRelease) });
      fs.rmSync(oldReleaseFile);
    }
    const handoff = releaseStore.value.transferBundle;
    if (handoff) {
      releaseCache = JSON.parse(handoff);
      if (!releaseCache || typeof releaseCache.requestId !== "string" || !releaseCache.bundle) throw new Error("invalid_release_cache");
    }
    if (!owner.protocol) owner.protocol = PROTOCOL;
    if (owner.owner === "local" && owner.deviceId != null && typeof owner.deviceId !== "string") throw new Error("invalid_ownership");
    if (owner.owner === "server" && (typeof owner.deviceId !== "string" || !owner.deviceId)) throw new Error("invalid_ownership");
  } catch (error) {
    releaseLock();
    throw new Error(`service_state_corrupt:${error.message}`);
  }

  const saveOwner = () => atomicJson(ownershipFile, owner);
  const commitOwner = (next) => {
    atomicJson(ownershipFile, next);
    owner = next;
  };
  const requestFile = (id) => path.join(ledgerDir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  const lookupRequest = (id) => {
    try { return JSON.parse(fs.readFileSync(requestFile(id), "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return legacyLedger.find((row) => row.id === id) || null;
  };
  const saveRequest = (entry) => atomicJson(requestFile(entry.id), {
    operation: entry.operation,
    deviceId: entry.deviceId,
    state: entry.state,
    at: entry.at,
    ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
  });
  const saveReleaseCache = (value) => {
    releaseStore.save({ transferBundle: JSON.stringify(value) });
    syncFileAndDirectory(releaseStore.file);
  };
  const clearReleaseCache = () => {
    releaseStore.clearSecret("transferBundle");
  };
  privateDir(ledgerDir);
  if (legacyLedger.length) {
    for (const entry of legacyLedger) {
      if (!fs.existsSync(requestFile(entry.id))) saveRequest(entry);
    }
    fs.renameSync(legacyLedgerFile, `${legacyLedgerFile}.migrated`);
    legacyLedger = [];
  }
  if (!fs.existsSync(ownershipFile)) {
    try { saveOwner(); } catch (error) {
      releaseLock();
      throw new Error(`service_state_unwritable:${error.message}`);
    }
  }
  let activeHost = host;
  const redactions = [token];
  const refreshRedactions = () => {
    const settings = activeHost && activeHost.engine && activeHost.engine.settings;
    if (!settings) return;
    for (const key of ["apiKey", "apiSecret", "apiPassphrase", "privateKey", "proxyUrl"]) {
      const value = settings[key];
      if (typeof value === "string" && value && !redactions.includes(value)) redactions.push(value);
    }
  };
  const eventRows = [];
  let eventCursor = 0;
  let queue = Promise.resolve();
  let closing = false;
  const serialize = (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };

  const onEvent = (event) => {
    if (!event || typeof event.type !== "string") return;
    refreshRedactions();
    const safe = { id: ++eventCursor, type: event.type.slice(0, 80), payload: clean(event.payload, 0, redactions) };
    if (event.state !== undefined) safe.state = clean(event.state, 0, redactions);
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      delete safe.state;
      safe.payload = { omitted: true };
    }
    eventRows.push(safe);
    if (eventRows.length > MAX_EVENTS) eventRows.splice(0, eventRows.length - MAX_EVENTS);
    const state = event.state;
    const status = typeof event.payload === "string" ? event.payload : state && state.status;
    const venueDown = status === "venue_down" || (status === "paused" && state && /^venue_down:/.test(state.pauseReason || ""));
    if (!closing && status && ["stopped", "halt", "paused", "daily_limit"].includes(status) && !venueDown && owner.desiredRunning) {
      owner.desiredRunning = false;
      try { saveOwner(); } catch { /* a later explicit command will surface disk errors */ }
    }
  };

  try {
    if (!activeHost) {
      const factory = hostFactory || ((options) => {
        const { ExecutionHost } = require("../main/executionHost");
        return new ExecutionHost(options);
      });
      activeHost = factory({ userDataDir, direct: true, onEvent });
    } else if (typeof activeHost.on === "function") {
      activeHost.on(onEvent);
    }
  } catch (error) {
    releaseLock();
    throw error;
  }
  if (!activeHost) {
    releaseLock();
    throw new TypeError("host is required");
  }
  refreshRedactions();

  const currentRequest = (id) => lookupRequest(id);
  const beginRequest = (id, operation, deviceId, { fingerprint, resumeActivation = false } = {}) => {
    const previous = currentRequest(id);
    if (previous) {
      if (previous.operation !== operation || previous.deviceId !== deviceId) throw new ServiceError("request_id_conflict", 409);
      if (previous.state === "pending") {
        if (resumeActivation && operation === "activate" && previous.fingerprint === fingerprint) return;
        if (resumeActivation && operation === "activate") throw new ServiceError("request_id_conflict", 409);
        throw new ServiceError("command_outcome_unknown", 409);
      }
      throw new ServiceError("request_already_completed", 409);
    }
    saveRequest({ id, operation, deviceId, state: "pending", at: now(), fingerprint });
  };
  const finishRequest = (id) => {
    const entry = currentRequest(id);
    if (entry) saveRequest({ id, ...entry, state: "done" });
  };
  const forgetRequest = (id) => {
    try { fs.rmSync(requestFile(id), { force: true }); } catch { /* leave a pending tombstone if disk removal fails */ }
  };
  const requestId = (body) => {
    if (!body || typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 128) throw new ServiceError("invalid_request_id");
    return body.requestId;
  };
  const deviceId = (body) => {
    if (!body || typeof body.deviceId !== "string" || !body.deviceId.trim() || body.deviceId.length > 200) throw new ServiceError("invalid_device_id");
    return body.deviceId;
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new ServiceError("body_too_large", 413));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body_must_be_object");
        resolve(value);
      } catch { reject(new ServiceError("invalid_json")); }
    });
    req.on("error", () => reject(new ServiceError("request_aborted", 400)));
  });
  const send = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  };
  const executionStatus = (snapshot = null) => ({
    owner: owner.owner,
    deviceId: owner.deviceId,
    epoch: owner.epoch,
    connected: owner.owner === "server" && owner.lastSeenAt != null && now() - owner.lastSeenAt <= 30_000,
    lastSeenAt: owner.lastSeenAt,
    desiredRunning: owner.desiredRunning,
    version: (snapshot && snapshot.version) || require("../../package.json").version,
  });
  const authorize = (req) => {
    const header = req.headers.authorization || "";
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match) throw new ServiceError("unauthorized", 401);
    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new ServiceError("unauthorized", 401);
  };
  const stripProxy = (method, args) => {
    if (!["saveSettings", "connect", "ping", "deriveKeys"].includes(method)) return args;
    const input = args.slice();
    if (input[0] && typeof input[0] === "object" && !Array.isArray(input[0])) {
      input[0] = { ...input[0] };
      delete input[0].proxyUrl;
    }
    return input;
  };
  const warmServerChart = () => {
    if (closing || owner.owner !== "server") return;
    serialize(async () => {
      if (closing || owner.owner !== "server") return;
      try { await activeHost.call("warmChart"); } catch { /* chart warmup must not affect execution ownership */ }
    });
  };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { healthy: true, protocol: PROTOCOL });
      authorize(req);
      if (req.method === "GET" && url.pathname === "/v1/status") {
        let snapshot = null;
        if (owner.owner === "server") snapshot = await activeHost.call("snapshot");
        return send(res, 200, { protocol: PROTOCOL, ...executionStatus(snapshot) });
      }
      if (req.method === "GET" && url.pathname === "/v1/snapshot") {
        if (owner.owner !== "server") return send(res, 200, { execution: executionStatus(), state: null });
        const state = await activeHost.call("snapshot");
        refreshRedactions();
        return send(res, 200, { state: clean(state, 0, redactions), execution: executionStatus(state) });
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const after = url.searchParams.get("after") || "0";
        if (!/^\d+$/.test(after)) throw new ServiceError("invalid_cursor");
        const cursor = Number(after);
        const events = eventRows.filter((event) => event.id > cursor).slice(0, 500);
        return send(res, 200, { events, cursor: events.length ? events[events.length - 1].id : eventCursor });
      }
      if (req.method !== "POST") throw new ServiceError("not_found", 404);
      const max = url.pathname === "/v1/activate" ? MAX_BUNDLE + 128 * 1024 : MAX_BODY;
      const body = await readBody(req, max);
      if (url.pathname === "/v1/heartbeat") {
        const id = deviceId(body);
        if (!owner.deviceId || owner.deviceId !== id) return send(res, 200, { ok: true, connected: false });
        owner.lastSeenAt = now();
        saveOwner();
        return send(res, 200, { ok: true, connected: owner.owner === "server" });
      }
      if (url.pathname === "/v1/register") return send(res, 200, await serialize(async () => {
        const id = requestId(body);
        const device = deviceId(body);
        if (owner.owner !== "local") throw new ServiceError("not_local_owner", 409);
        if (owner.deviceId && owner.deviceId !== device) throw new ServiceError("device_already_registered", 409);
        if (owner.deviceId === device && owner.registrationRequestId === id) return { ok: true, owner: "local", deviceId: device, epoch: owner.epoch };
        if (owner.deviceId === device && owner.registrationRequestId && owner.registrationRequestId !== id) return { ok: true, owner: "local", deviceId: device, epoch: owner.epoch };
        beginRequest(id, "register", device);
        commitOwner({ ...owner, deviceId: device, registrationRequestId: id });
        finishRequest(id);
        return { ok: true, owner: "local", deviceId: device, epoch: owner.epoch };
      }));
      if (url.pathname === "/v1/command") return send(res, 200, await serialize(async () => {
        const id = requestId(body);
        const device = deviceId(body);
        if (owner.deviceId !== device) throw new ServiceError("owner_device_mismatch", 409);
        if (owner.owner !== "server") throw new ServiceError("not_server_owner", 409);
        if (typeof body.method !== "string" || !METHODS.has(body.method)) throw new ServiceError("method_not_allowed", 400);
        if (!Array.isArray(body.args || [])) throw new ServiceError("invalid_arguments");
        beginRequest(id, `command:${body.method}`, device);
        const args = stripProxy(body.method, body.args || []);
        try {
          const result = await activeHost.call(body.method, args);
          refreshRedactions();
          if (body.method === "start") {
            owner.desiredRunning = Boolean(result && result.ok);
            saveOwner();
          } else if (body.method === "stop") {
            owner.desiredRunning = false;
            saveOwner();
          }
          finishRequest(id);
          return clean(result, 0, redactions);
        } catch (error) {
          if (["invalid_settings", "settings_locked"].includes(error && error.code)) {
            finishRequest(id);
            throw new ServiceError(error.code, 409);
          }
          throw new ServiceError("command_outcome_unknown", 503);
        }
      }));
      if (url.pathname === "/v1/activate") return send(res, 200, await serialize(async () => {
        const id = requestId(body);
        const device = deviceId(body);
        if (body.bundle == null || Buffer.byteLength(JSON.stringify(body.bundle)) > MAX_BUNDLE) throw new ServiceError("invalid_bundle");
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(body.bundle)).digest("hex");
        if (owner.owner === "server" && owner.activationRequestId === id && owner.deviceId === device) {
          if (owner.activationFingerprint && owner.activationFingerprint !== fingerprint) throw new ServiceError("request_id_conflict", 409);
          return { ok: true, owner: "server", epoch: owner.epoch };
        }
        if (owner.deviceId !== device) throw new ServiceError("owner_device_mismatch", 409);
        if (owner.owner !== "local") throw new ServiceError("not_local_owner", 409);
        beginRequest(id, "activate", device, { fingerprint, resumeActivation: true });
        if (typeof activeHost.idle === "function" && !activeHost.idle()) throw new ServiceError("execution_busy", 409);
        try {
          await activeHost.importBundle(body.bundle);
        } catch (error) {
          if (["invalid_transfer", "transfer_has_position", "execution_busy"].includes(error && error.code)) {
            forgetRequest(id);
            throw new ServiceError(error.code === "invalid_transfer" ? "invalid_transfer" : "execution_busy", 409);
          }
          throw new ServiceError("command_outcome_unknown", 503);
        }
        refreshRedactions();
        clearReleaseCache();
        releaseCache = null;
        commitOwner({ ...owner, protocol: PROTOCOL, owner: "server", deviceId: device, epoch: owner.epoch + 1, desiredRunning: false, lastSeenAt: now(), activationRequestId: id, activationFingerprint: fingerprint });
        finishRequest(id);
        warmServerChart();
        return { ok: true, owner: "server", epoch: owner.epoch };
      }));
      if (url.pathname === "/v1/release") return send(res, 200, await serialize(async () => {
        const id = requestId(body);
        const device = deviceId(body);
        if (releaseCache && releaseCache.requestId === id && releaseCache.deviceId === device) {
          if (owner.deviceId !== device) throw new ServiceError("owner_device_mismatch", 409);
          if (owner.owner === "server" && owner.deviceId === device) {
            if (typeof activeHost.quiesce === "function") await activeHost.quiesce();
            if (typeof activeHost.idle === "function" && !activeHost.idle()) throw new ServiceError("execution_not_idle", 409);
            commitOwner({ ...owner, owner: "local", deviceId: device, desiredRunning: false });
          }
          return { bundle: releaseCache.bundle, execution: executionStatus() };
        }
        if (owner.deviceId !== device) throw new ServiceError("owner_device_mismatch", 409);
        if (owner.owner !== "server" || owner.deviceId !== device) throw new ServiceError("not_server_owner", 409);
        beginRequest(id, "release", device);
        try {
          await activeHost.quiesce();
          if (typeof activeHost.idle === "function" && !activeHost.idle()) throw new ServiceError("execution_not_idle", 409);
          const bundle = await activeHost.exportBundle();
          if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE) throw new ServiceError("bundle_too_large", 413);
          const nextReleaseCache = { requestId: id, deviceId: device, bundle };
          saveReleaseCache(nextReleaseCache);
          releaseCache = nextReleaseCache;
          commitOwner({ ...owner, owner: "local", deviceId: device, desiredRunning: false });
          finishRequest(id);
          return { bundle, execution: executionStatus() };
        } catch (error) {
          if (error instanceof ServiceError) {
            if (["execution_not_idle", "settings_locked"].includes(error.code)) forgetRequest(id);
            throw error;
          }
          if (error && ["settings_locked", "execution_busy"].includes(error.code)) {
            forgetRequest(id);
            throw new ServiceError("settings_locked", 409);
          }
          throw new ServiceError("command_outcome_unknown", 503);
        }
      }));
      throw new ServiceError("not_found", 404);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      const code = error instanceof ServiceError ? error.code : "internal_error";
      send(res, status, { error: code });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.timeout = 60_000;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("listening", () => {
    if (owner.owner !== "server") return;
    warmServerChart();
    if (!owner.desiredRunning) return;
    const engine = activeHost.engine;
    if (engine && ((typeof engine.journal?.pendingOrder === "function" && engine.journal.pendingOrder()) || engine.risk?.halted)) {
      owner.desiredRunning = false;
      try { saveOwner(); } catch { /* fail closed: no auto-resume */ }
      return;
    }
    serialize(async () => {
      try {
        const result = await activeHost.call("start", [{ confirmLive: true }]);
        if (!result || result.ok === false) owner.desiredRunning = false;
      } catch { owner.desiredRunning = false; }
      saveOwner();
    });
  });

  const close = async () => {
    closing = true;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await queue;
    try {
      if (typeof activeHost.dispose === "function") await activeHost.dispose();
    } finally {
      if (releaseLock) { releaseLock(); releaseLock = null; }
    }
  };
  return { server, close, get owner() { return { ...owner }; }, get host() { return activeHost; } };
}

module.exports = { createService, MAX_BODY, MAX_BUNDLE, METHODS };
