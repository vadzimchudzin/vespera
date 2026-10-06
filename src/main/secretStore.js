"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SAFE_PREFIX = "enc:v2:safe:";
const MASTER_PREFIX = "enc:v2:master:";
const LEGACY_SAFE_PREFIX = "enc:v1:";
const LEGACY_LOCAL_PREFIX = "encl:v1:";
const keyCache = new Map();

function safeStorage() {
  try {
    const store = require("electron").safeStorage;
    if (!store || typeof store.isEncryptionAvailable !== "function" || !store.isEncryptionAvailable()) return null;
    if (process.platform === "linux" && typeof store.getSelectedStorageBackend === "function"
      && store.getSelectedStorageBackend() === "basic_text") return null;
    return store;
  } catch {
    return null;
  }
}

function keyPaths(scope) {
  const dir = path.join(path.resolve(scope || "vespera"), ".secrets");
  return { dir, file: path.join(dir, "master.key") };
}

function syncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function readMasterKey(scope, { create = false } = {}) {
  const { dir, file } = keyPaths(scope);
  const cached = keyCache.get(file);
  if (cached) return cached;

  let key;
  try {
    const stat = fs.lstatSync(file);
    const dirStat = fs.lstatSync(dir);
    if (!stat.isFile() || stat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.isSymbolicLink()
      || (process.platform !== "win32" && ((stat.mode & 0o077) || (dirStat.mode & 0o077)))) {
      throw new Error("secret_key_permissions_invalid");
    }
    key = fs.readFileSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) throw new Error("secret_key_missing");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch (chmodError) {
      if (process.platform !== "win32") throw new Error("secret_key_permissions_invalid", { cause: chmodError });
    }
    key = crypto.randomBytes(32);
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, key);
      fs.fsyncSync(fd);
    } catch (writeError) {
      if (fd != null) fs.closeSync(fd);
      key.fill(0);
      if (writeError.code === "EEXIST") return readMasterKey(scope);
      throw new Error(`secret_key_unavailable:${writeError.code || "io"}`, { cause: writeError });
    }
    fs.closeSync(fd);
    try {
      fs.chmodSync(file, 0o600);
      syncDirectory(dir);
    } catch (syncError) {
      if (process.platform !== "win32") throw new Error("secret_key_sync_failed", { cause: syncError });
    }
  }
  if (key.length !== 32) throw new Error("secret_key_invalid");
  keyCache.set(file, key);
  return key;
}

function encryptWithKey(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return MASTER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function decryptWithKey(value, key) {
  const raw = Buffer.from(value.slice(MASTER_PREFIX.length), "base64");
  if (raw.length < 28 || raw.toString("base64") !== value.slice(MASTER_PREFIX.length)) {
    throw new Error("secret_ciphertext_invalid");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

function legacyKey(scope) {
  return crypto.scryptSync(`${os.hostname()}::${os.userInfo().username}::${scope}`, "vespera.settings.v1", 32);
}

function decryptLegacyLocal(value, scope, prefix) {
  const raw = Buffer.from(value.slice(prefix.length), "base64");
  if (raw.length < 28 || raw.toString("base64") !== value.slice(prefix.length)) {
    throw new Error("secret_ciphertext_invalid");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKey(scope), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

function encryptSecret(value, scope, options = {}) {
  if (value == null || value === "") return "";
  const text = String(value);
  if (text.startsWith(SAFE_PREFIX) || text.startsWith(MASTER_PREFIX)
    || text.startsWith(LEGACY_SAFE_PREFIX) || text.startsWith(LEGACY_LOCAL_PREFIX)) return text;
  if (options.masterKey) return encryptWithKey(text, options.masterKey);
  const store = safeStorage();
  if (store) {
    try {
      return SAFE_PREFIX + store.encryptString(text).toString("base64");
    } catch (error) {
      throw new Error("secret_encryption_failed", { cause: error });
    }
  }
  return encryptWithKey(text, readMasterKey(scope, { create: true }));
}

function decryptSecret(value, scope) {
  if (typeof value !== "string" || value === "") return "";
  if (value.startsWith(SAFE_PREFIX)) {
    const store = safeStorage();
    if (!store) throw new Error("secret_safe_storage_unavailable");
    try {
      const encoded = value.slice(SAFE_PREFIX.length);
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error("invalid_base64");
      return store.decryptString(bytes);
    } catch (error) {
      throw new Error("secret_decryption_failed", { cause: error });
    }
  }
  if (value.startsWith(MASTER_PREFIX)) return decryptWithKey(value, readMasterKey(scope));
  if (value.startsWith(LEGACY_LOCAL_PREFIX)) return decryptLegacyLocal(value, scope, LEGACY_LOCAL_PREFIX);
  if (value.startsWith(LEGACY_SAFE_PREFIX)) {
    const store = safeStorage();
    if (store) {
      try {
        return store.decryptString(Buffer.from(value.slice(LEGACY_SAFE_PREFIX.length), "base64"));
      } catch { /* Older builds also used this prefix for the machine-derived cipher. */ }
    }
    return decryptLegacyLocal(value, scope, LEGACY_SAFE_PREFIX);
  }
  if (value.startsWith("enc:") || value.startsWith("encl:")) throw new Error("secret_ciphertext_unsupported");
  return value;
}

function releaseSecretCache(scope) {
  const { file } = keyPaths(scope);
  const key = keyCache.get(file);
  if (key) key.fill(0);
  keyCache.delete(file);
}

function replaceMasterKey(scope, key) {
  const { dir, file } = keyPaths(scope);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.next`;
  let fd;
  try {
    fd = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  syncDirectory(dir);
  releaseSecretCache(scope);
  keyCache.set(file, key);
}

function stageMasterKey(scope, key) {
  const { dir, file } = keyPaths(scope);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (error) { if (process.platform !== "win32") throw error; }
  const staged = `${file}.next`;
  let fd;
  try {
    fd = fs.openSync(staged, "w", 0o600);
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  fs.chmodSync(staged, 0o600);
  syncDirectory(dir);
}

function commitStagedMasterKey(scope) {
  const { dir, file } = keyPaths(scope);
  const staged = `${file}.next`;
  const stat = fs.lstatSync(staged);
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("secret_key_permissions_invalid");
  const key = fs.readFileSync(staged);
  if (key.length !== 32) throw new Error("secret_key_invalid");
  fs.renameSync(staged, file);
  syncDirectory(dir);
  releaseSecretCache(scope);
  keyCache.set(file, key);
}

function recoverSecretRotation(scope) {
  const { dir, file } = keyPaths(scope);
  const journal = path.join(dir, "rotation.json");
  const staged = `${file}.next`;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      try { fs.unlinkSync(staged); } catch { /* absent */ }
      try { fs.unlinkSync(`${path.resolve(scope)}/settings.json.rotation`); } catch { /* absent */ }
      try { fs.unlinkSync(`${journal}.tmp`); } catch { /* absent */ }
      return;
    }
    throw new Error("secret_rotation_journal_invalid", { cause: error });
  }
  if (!record || record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.settingsHash || "")) {
    throw new Error("secret_rotation_journal_invalid");
  }
  let activeHash = null;
  try {
    activeHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(path.resolve(scope), "settings.json"))).digest("hex");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("secret_rotation_recovery_failed", { cause: error });
  }
  if (activeHash === record.settingsHash) {
    try {
      fs.lstatSync(staged);
      commitStagedMasterKey(scope);
    } catch (error) {
      if (error.code !== "ENOENT" || !masterKeyMatchesSettings(scope)) {
        throw new Error("secret_rotation_recovery_failed", { cause: error });
      }
    }
  }
  else {
    try { fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { fs.unlinkSync(`${path.resolve(scope)}/settings.json.rotation`); } catch { /* absent */ }
  fs.unlinkSync(journal);
  syncDirectory(dir);
}

function masterKeyMatchesSettings(scope) {
  const { file } = keyPaths(scope);
  let key;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
      || (process.platform !== "win32" && (stat.mode & 0o077))) return false;
    key = fs.readFileSync(file);
    if (key.length !== 32) return false;
    const settings = JSON.parse(fs.readFileSync(path.join(path.resolve(scope), "settings.json"), "utf8"));
    const encrypted = ["apiKey", "apiSecret", "apiPassphrase", "privateKey", "serverToken", "transferBundle"]
      .map((field) => settings[field]).filter((value) => typeof value === "string" && value.startsWith(MASTER_PREFIX));
    return encrypted.every((value) => decryptWithKey(value, key) != null);
  } catch {
    return false;
  } finally {
    if (key) key.fill(0);
  }
}

module.exports = {
  SAFE_PREFIX,
  MASTER_PREFIX,
  encryptSecret,
  decryptSecret,
  readMasterKey,
  releaseSecretCache,
  replaceMasterKey,
  stageMasterKey,
  commitStagedMasterKey,
  recoverSecretRotation,
  masterKeyMatchesSettings,
  syncDirectory,
};
