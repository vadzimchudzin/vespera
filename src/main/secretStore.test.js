"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MASTER_PREFIX,
  encryptSecret,
  decryptSecret,
  readMasterKey,
  releaseSecretCache,
  stageMasterKey,
} = require("./secretStore");
const { SettingsStore, SECRET_FIELDS } = require("./settingsStore");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vespera-secrets-"));
}

function legacyCipher(value, key, prefix) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function run() {
  const dir = tempDir();
  try {
    const encrypted = encryptSecret("correct horse battery staple", dir);
    assert(encrypted.startsWith(MASTER_PREFIX), "fallback uses versioned master-key encryption");
    assert.strictEqual(decryptSecret(encrypted, dir), "correct horse battery staple");
    const keyPath = path.join(dir, ".secrets", "master.key");
    const keyStat = fs.statSync(keyPath);
    assert.strictEqual(keyStat.size, 32, "master key has 256 bits");
    if (process.platform !== "win32") {
      assert.strictEqual(keyStat.mode & 0o777, 0o600, "master key is owner-only");
      assert.strictEqual(fs.statSync(path.dirname(keyPath)).mode & 0o777, 0o700, "key directory is owner-only");
    }

    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
    assert.throws(() => decryptSecret(tampered, dir), /Unsupported state|authenticate|secret/i, "GCM detects ciphertext tampering");
    assert.throws(() => encryptSecret("x", dir, { masterKey: Buffer.alloc(1) }), "invalid master key cannot fall back to plaintext");

    const legacyKey = crypto.scryptSync(`${os.hostname()}::${os.userInfo().username}::${dir}`, "vespera.settings.v1", 32);
    assert.strictEqual(decryptSecret(legacyCipher("old-local", legacyKey, "encl:v1:"), dir), "old-local");
    assert.strictEqual(decryptSecret(legacyCipher("old-enc-local", legacyKey, "enc:v1:"), dir), "old-enc-local");
    assert.strictEqual(decryptSecret("old-plain", dir), "old-plain");

    const noKey = tempDir();
    try {
      assert.throws(() => decryptSecret(encrypted, noKey), /secret_key_missing/);
      assert(!fs.existsSync(path.join(noKey, ".secrets", "master.key")), "decrypt never generates a replacement key");
      assert.strictEqual(readMasterKey(dir).length, 32);
      releaseSecretCache(dir);
    } finally {
      fs.rmSync(noKey, { recursive: true, force: true });
    }

    const rotationDir = tempDir();
    try {
      const store = new SettingsStore(rotationDir);
      store.save({ apiSecret: "recover-rotation" });
      const nextKey = crypto.randomBytes(32);
      stageMasterKey(rotationDir, nextKey);
      const stagedSettings = { ...store.value };
      for (const field of SECRET_FIELDS) stagedSettings[field] = encryptSecret(store.value[field], rotationDir, { masterKey: nextKey });
      const settingsPath = path.join(rotationDir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify(stagedSettings));
      const journalDir = path.join(rotationDir, ".secrets");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(settingsPath)).digest("hex");
      fs.writeFileSync(path.join(journalDir, "rotation.json"), JSON.stringify({ version: 1, settingsHash: hash }), { mode: 0o600 });
      releaseSecretCache(rotationDir);
      assert.strictEqual(new SettingsStore(rotationDir).value.apiSecret, "recover-rotation", "startup completes a committed rotation");
      assert(!fs.existsSync(path.join(journalDir, "rotation.json")), "recovery clears its journal");
    } finally {
      releaseSecretCache(rotationDir);
      fs.rmSync(rotationDir, { recursive: true, force: true });
    }
    console.log("secret store tests ok");
  } finally {
    releaseSecretCache(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run();
