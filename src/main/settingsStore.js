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

module.exports = { SettingsStore, DEFAULTS, SECRET_FIELDS };
