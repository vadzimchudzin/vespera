"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { clampRefreshMs } = require("./markets");
const { normalizeSettings } = require("../shared/settings");

/**
 * Settings persistence.
 *
 * TZ 11: API secrets must not sit in the config as plain text.
 * apiKey / apiSecret / apiPassphrase are encrypted with Electron safeStorage
 * when it is available (OS keychain), otherwise with a machine-bound
 * AES-256-GCM key. Values written by older builds are read as-is and
 * re-encrypted on the next save.
 */

const SECRET_FIELDS = ["apiKey", "apiSecret", "apiPassphrase", "privateKey", "serverToken", "transferBundle"];
const ENC_PREFIX = "enc:v1:";
const LOCAL_PREFIX = "encl:v1:";

const DEFAULTS = {
  symbol: "BTCUSDT",
  timeframe: "15m",
  baseUsd: "1.00",
  maxSteps: 6,
  sizingMode: "double",
  fixedStakes: [1, 2, 4, 8, 16, 32],
  maxSeriesLossUsd: 0,
  maxStakeUsd: 0,
  maxEntryPrice: 1,
  // Auto signs and checks the balance but does not post orders until turned off.
  dryRun: true,
  dailyLossLimitUsd: 0,
  paperBalance: "1000.00",
  mode: "paper",
  theme: "glass-dark",
  locale: "en",
  apiKey: "",
  apiSecret: "",
  apiPassphrase: "",
  privateKey: "",
  walletType: "AUTO",
  proxyUrl: "",
  walletAddress: "",
  apiBase: "https://clob.polymarket.com",
  clobUrl: "https://clob.polymarket.com",
  gammaUrl: "https://gamma-api.polymarket.com",
  maType: "SMA",
  strategyId: "sma200_20",
  minOpeningAtr: 0,
  minCrossTicks: 0,
  confirmCount: 0,
  fullBodyOnS: false,
  fastPeriod: 20,
  slowPeriod: 200,
  refreshMs: 100,
  notificationsEnabled: true,
};

function safeStorage() {
  try {
    // Electron is absent in unit tests and in any plain-node tooling.
    const electron = require("electron");
    const store = electron && electron.safeStorage;
    if (store && typeof store.isEncryptionAvailable === "function" && store.isEncryptionAvailable()) {
      return store;
    }
  } catch {
    /* not running inside Electron */
  }
  return null;
}

function localKey(scope) {
  return crypto.scryptSync(`${os.hostname()}::${os.userInfo().username}::${scope}`, "vespera.settings.v1", 32);
}

function encryptLocal(value, scope) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", localKey(scope), iv);
  const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return LOCAL_PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

function decryptLocal(value, scope) {
  const raw = Buffer.from(value.slice(LOCAL_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", localKey(scope), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function encryptSecret(value, scope) {
  if (value == null || value === "") return "";
  const str = String(value);
  if (str.startsWith(ENC_PREFIX) || str.startsWith(LOCAL_PREFIX)) return str;
  const store = safeStorage();
  if (store) {
    try {
      return ENC_PREFIX + store.encryptString(str).toString("base64");
    } catch {
      /* fall through to the local cipher */
    }
  }
  try {
    return encryptLocal(str, scope);
  } catch {
    return str;
  }
}

function decryptSecret(value, scope) {
  if (typeof value !== "string" || !value) return "";
  if (value.startsWith(ENC_PREFIX)) {
    const store = safeStorage();
    if (!store) return "";
    try {
      return store.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), "base64"));
    } catch {
      return "";
    }
  }
  if (value.startsWith(LOCAL_PREFIX)) {
    try {
      return decryptLocal(value, scope);
    } catch {
      return "";
    }
  }
  return value; // legacy plain value, re-encrypted on the next save
}

const TELEGRAM_DEFAULTS = Object.freeze({
  version: 1,
  token: "",
  enabled: false,
  botUsername: "",
  admins: [],
  users: [],
  requests: [],
  pairing: null,
  confirmations: [],
  lastUpdateId: null,
  outbox: [],
  deadLetters: [],
  desktopConnected: null,
  lastError: null,
});

class TelegramConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.keyFile = path.join(dir, "telegram-master.key");
    this.file = path.join(dir, "telegram-config.enc");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { if (process.platform !== "win32") throw new Error("telegram_storage_unavailable"); }
    this._key = this._loadKey();
  }

  _loadKey() {
    let key;
    try {
      const stat = fs.lstatSync(this.keyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) {
        throw new Error("telegram_key_permissions_invalid");
      }
      key = fs.readFileSync(this.keyFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (fs.existsSync(this.file)) throw new Error("telegram_key_missing");
      key = crypto.randomBytes(32);
      let fd;
      try {
        fd = fs.openSync(this.keyFile, "wx", 0o600);
        fs.writeFileSync(fd, key);
        fs.fsyncSync(fd);
      } catch (writeError) {
        if (fd != null) fs.closeSync(fd);
        throw new Error(`telegram_key_unavailable:${writeError.code || "io"}`);
      }
      fs.closeSync(fd);
      try { fs.chmodSync(this.keyFile, 0o600); } catch { if (process.platform !== "win32") throw new Error("telegram_key_permissions_invalid"); }
      try {
        const dirFd = fs.openSync(this.dir, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { if (process.platform !== "win32") throw new Error("telegram_key_sync_failed"); }
    }
    if (key.length !== 32) throw new Error("telegram_key_invalid");
    return key;
  }

  read() {
    if (!fs.existsSync(this.file)) return { ...TELEGRAM_DEFAULTS, admins: [], users: [], requests: [], confirmations: [], outbox: [], deadLetters: [] };
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) {
      throw new Error("telegram_config_permissions_invalid");
    }
    const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!envelope || envelope.version !== 1 || typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" || typeof envelope.data !== "string") throw new Error("telegram_config_invalid");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this._key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
      const value = JSON.parse(plaintext);
      if (!value || value.version !== 1 || typeof value.token !== "string" || !Array.isArray(value.admins) ||
          !Array.isArray(value.users) || !Array.isArray(value.requests) || !Array.isArray(value.outbox) ||
          !Array.isArray(value.confirmations)) throw new Error("telegram_config_invalid");
      if (value.enabled == null) value.enabled = false;
      if (!Array.isArray(value.deadLetters)) value.deadLetters = [];
      if (typeof value.enabled !== "boolean" || value.admins.length > 1 || value.admins.some((id) => !/^\d{1,20}$/.test(id)) ||
          value.users.length > 10_000 || value.users.some((id) => !/^\d{1,20}$/.test(id)) ||
          new Set(value.users).size !== value.users.length || value.requests.length > 10_000 ||
          value.requests.some((row) => !row || !/^\d{1,20}$/.test(row.userId) || !Number.isFinite(row.requestedAt)) ||
          value.outbox.length > 1000 || value.outbox.some((row) => !row || typeof row.id !== "string" ||
            !/^\d{1,20}$/.test(row.chatId) || typeof row.text !== "string" || !Number.isFinite(row.nextAt) ||
            !Number.isInteger(row.attempts) || row.attempts < 0) ||
          value.deadLetters.length > 100 || value.deadLetters.some((row) => !row || typeof row.id !== "string" ||
            !/^\d{1,20}$/.test(row.chatId) || typeof row.error !== "string" || !Number.isFinite(row.failedAt)) ||
          value.confirmations.length > 20 || (value.lastUpdateId != null && (!Number.isSafeInteger(value.lastUpdateId) || value.lastUpdateId < 0)) ||
          (value.lastError != null && typeof value.lastError !== "string")) throw new Error("telegram_config_invalid");
      return value;
    } catch (error) {
      if (error.message === "telegram_config_invalid") throw error;
      throw new Error("telegram_config_decryption_failed");
    }
  }

  write(value) {
    if (!value || value.version !== 1 || typeof value.token !== "string" || typeof value.enabled !== "boolean" ||
        !Array.isArray(value.admins) || value.admins.length > 1 || !Array.isArray(value.users) ||
        !Array.isArray(value.requests) || !Array.isArray(value.confirmations) || !Array.isArray(value.outbox) ||
        value.outbox.length > 1000 || (value.deadLetters != null && (!Array.isArray(value.deadLetters) || value.deadLetters.length > 100))) throw new Error("telegram_config_invalid");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this._key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, envelope); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { if (process.platform !== "win32") throw new Error("telegram_config_permissions_invalid"); }
    try {
      const dir = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { if (process.platform !== "win32") throw new Error("telegram_config_sync_failed"); }
    return value;
  }

  update(mutator) {
    const value = this.read();
    const result = mutator(value);
    this.write(value);
    return result;
  }
}

class SettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "settings.json");
    this.scope = userDataDir || "vespera";
    this.value = normalizeSettings({ ...DEFAULTS, ...this._read() }, {}, { strict: false });
    this.value.refreshMs = clampRefreshMs(this.value.refreshMs);
  }

  _read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const key of SECRET_FIELDS) {
        if (raw[key]) raw[key] = decryptSecret(raw[key], this.scope);
      }
      return raw;
    } catch {
      return {};
    }
  }

  /** Empty strings for secrets are ignored: the UI never re-sends a stored key. */
  save(patch = {}) {
    const clean = { ...patch };
    for (const key of SECRET_FIELDS) {
      if (key in clean && (clean[key] == null || clean[key] === "")) delete clean[key];
    }
    this.value = { ...this.value, ...normalizeSettings(clean, this.value) };
    if (clean.refreshMs != null) this.value.refreshMs = clampRefreshMs(clean.refreshMs);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const onDisk = { ...this.value };
    for (const key of SECRET_FIELDS) {
      onDisk[key] = encryptSecret(this.value[key], this.scope);
    }
    fs.writeFileSync(this.file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* windows */
    }
    return this.value;
  }

  /** Wipe a stored credential on purpose (UI "clear" action). */
  clearSecret(key) {
    if (!SECRET_FIELDS.includes(key)) return this.value;
    this.value[key] = "";
    return this.save({});
  }
}

module.exports = { SettingsStore, DEFAULTS, SECRET_FIELDS, TelegramConfigStore, TELEGRAM_DEFAULTS };
