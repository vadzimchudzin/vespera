"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MANIFEST = "manifest.json";
const RESTORE_FENCE = ".restore-validation.json";

function noSymlinkAncestors(input) {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail("symlink_not_allowed");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function realDirectory(input, { create = false } = {}) {
  const dir = path.resolve(input);
  noSymlinkAncestors(dir);
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("directory_invalid");
  return dir;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function walkTree(root, { skipMaintenanceLock = false } = {}) {
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === ".service.lock" || relative.startsWith(".service.lock/")) {
        if (skipMaintenanceLock && relative === ".service.lock") continue;
        fail("service_lock_present");
      }
      if (name === MANIFEST || name.includes("\0") || name === "." || name === "..") fail("backup_path_invalid");
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail("symlink_not_allowed");
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        visit(full, relative);
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        });
      } else fail("backup_entry_type_unsupported");
    }
  }
  visit(root);
  return entries;
}

function ensureNoLiveServiceLock(dataDir) {
  const lock = path.join(dataDir, ".service.lock");
  let stat;
  try { stat = fs.lstatSync(lock); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("service_lock_unverified");
  let owner;
  try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { fail("service_lock_unverified"); }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) fail("service_lock_unverified");
  try {
    process.kill(owner.pid, 0);
    fail("service_active");
  } catch (error) {
    if (error.code === "service_active") throw error;
    if (error.code !== "ESRCH") fail("service_lock_unverified");
  }
  fail("service_lock_present");
}

function acquireMaintenanceLock(dataDir) {
  ensureNoLiveServiceLock(dataDir);
  const lockDir = path.join(dataDir, ".service.lock");
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") ensureNoLiveServiceLock(dataDir);
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, purpose: "offline-backup" }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

function assertOutside(parent, child, code) {
  const relative = path.relative(parent, child);
  if (relative === "" || !relative.startsWith("..")) fail(code);
  const reverse = path.relative(child, parent);
  if (!reverse.startsWith("..") && reverse !== "") fail(code);
}

function existingEmptyDirectory(input) {
  const dir = path.resolve(input);
  noSymlinkAncestors(dir);
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("restore_target_invalid");
    if (fs.readdirSync(dir).length) fail("restore_target_not_empty");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return dir;
}

function safeRelative(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.posix.isAbsolute(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) fail("backup_path_invalid");
  return relative;
}

function verifyBackup(backupDir) {
  const root = realDirectory(backupDir);
  if (process.platform !== "win32" && (fs.statSync(root).mode & 0o077)) fail("backup_permissions_invalid");
  const manifestFile = path.join(root, MANIFEST);
  const stat = fs.lstatSync(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("backup_manifest_invalid");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.data) || !manifest.token ||
      !Number.isInteger(manifest.token.size) || typeof manifest.token.sha256 !== "string") fail("backup_manifest_invalid");
  const dataRoot = path.join(root, "data");
  const dataStat = fs.lstatSync(dataRoot);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) fail("backup_contents_invalid");
  const actualData = walkTree(dataRoot);
  const expectedData = manifest.data;
  if (JSON.stringify(actualData) !== JSON.stringify(expectedData)) fail("backup_checksum_mismatch");
  const tokenPath = path.join(root, "server.token");
  const tokenStat = fs.lstatSync(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.size !== manifest.token.size ||
      (process.platform !== "win32" && (tokenStat.mode & 0o077)) ||
      crypto.createHash("sha256").update(fs.readFileSync(tokenPath)).digest("hex") !== manifest.token.sha256) fail("backup_checksum_mismatch");
  const allowed = new Set([MANIFEST, "server.token", "data", ...actualData.map((entry) => `data/${entry.path}`)]);
  const seen = new Set();
  function collect(dir, prefix = "") {
    for (const name of fs.readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const entry = fs.lstatSync(path.join(dir, name));
      if (entry.isSymbolicLink() || !allowed.has(rel)) fail("backup_contents_invalid");
      seen.add(rel);
      if (entry.isDirectory()) collect(path.join(dir, name), rel);
    }
  }
  collect(root);
  if (seen.size !== allowed.size || !seen.has("data")) fail("backup_contents_invalid");
  return { root, manifest };
}

function backup({ dataDir, tokenFile, destination }) {
  const source = realDirectory(dataDir);
  const token = path.resolve(tokenFile);
  noSymlinkAncestors(token);
  const tokenStat = fs.lstatSync(token);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) fail("token_file_invalid");
  if (process.platform !== "win32" && (tokenStat.mode & 0o077)) fail("token_file_permissions_invalid");
  const tokenData = fs.readFileSync(token);
  if (tokenData.length < 32) fail("token_file_invalid");
  assertOutside(source, token, "token_file_must_be_outside_data");
  const target = path.resolve(destination);
  noSymlinkAncestors(target);
  assertOutside(source, target, "backup_destination_overlap");
  assertOutside(token, target, "backup_destination_overlap");
  const releaseLock = acquireMaintenanceLock(source);
  let targetCreated = false;
  try {
    try {
      fs.mkdirSync(target, { mode: 0o700 });
      targetCreated = true;
    } catch (error) {
      if (error.code === "EEXIST") fail("backup_destination_exists");
      throw error;
    }
    ensurePrivateDir(target);
    fs.mkdirSync(path.join(target, "data"), { mode: 0o700 });
    for (const entry of walkTree(source, { skipMaintenanceLock: true })) {
      const relative = safeRelative(entry.path);
      const from = path.join(source, ...relative.split("/"));
      const to = path.join(target, "data", ...relative.split("/"));
      if (entry.type === "directory") {
        fs.mkdirSync(to, { mode: entry.mode });
        if (process.platform !== "win32") fs.chmodSync(to, entry.mode);
      }
      else {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        if (process.platform !== "win32") fs.chmodSync(to, entry.mode);
      }
    }
    if (process.platform !== "win32") {
      for (const entry of walkTree(source, { skipMaintenanceLock: true }).filter((item) => item.type === "directory").reverse()) {
        fs.chmodSync(path.join(target, "data", ...safeRelative(entry.path).split("/")), entry.mode);
      }
    }
    const backupToken = path.join(target, "server.token");
    fs.copyFileSync(token, backupToken, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(backupToken, 0o600);
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      node: process.version,
      data: walkTree(path.join(target, "data")),
      token: { size: tokenData.length, sha256: crypto.createHash("sha256").update(tokenData).digest("hex"), mode: 0o600 },
    };
    fs.writeFileSync(path.join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { destination: target, files: manifest.data.filter((entry) => entry.type === "file").length + 1 };
  } catch (error) {
    if (targetCreated) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLock();
  }
}

function restore({ backupDir, dataDir, tokenFile, isolatedValidation, executorStart }) {
  if (isolatedValidation !== true || executorStart !== false) fail("restore_requires_isolated_no_executor_flags");
  const verified = verifyBackup(backupDir);
  const targetData = existingEmptyDirectory(dataDir);
  const targetToken = path.resolve(tokenFile);
  noSymlinkAncestors(targetToken);
  try {
    fs.lstatSync(targetToken);
    fail("restore_token_target_exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assertOutside(verified.root, targetData, "restore_target_overlap");
  assertOutside(verified.root, targetToken, "restore_target_overlap");
  const targetTokenParent = path.dirname(targetToken);
  const tokenParent = realDirectory(targetTokenParent, { create: true });
  fs.mkdirSync(path.dirname(targetData), { recursive: true, mode: 0o700 });
  realDirectory(path.dirname(targetData));
  const stageData = `${targetData}.restore-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const stageToken = path.join(tokenParent, `.vespera-token-restore-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let releaseLock;
  let createdTarget = false;
  let createdToken = false;
  let completed = false;
  const committed = [];
  try {
    fs.mkdirSync(stageData, { mode: 0o700 });
    const sourceData = path.join(verified.root, "data");
    for (const entry of verified.manifest.data) {
      const relative = safeRelative(entry.path);
      const from = path.join(sourceData, ...relative.split("/"));
      const to = path.join(stageData, ...relative.split("/"));
      if (entry.type === "directory") fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      else {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        if (process.platform !== "win32") fs.chmodSync(to, entry.mode);
      }
    }
    if (process.platform !== "win32") {
      for (const entry of verified.manifest.data.filter((item) => item.type === "directory").reverse()) {
        fs.chmodSync(path.join(stageData, ...safeRelative(entry.path).split("/")), entry.mode);
      }
    }
    fs.copyFileSync(path.join(verified.root, "server.token"), stageToken, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(stageData, RESTORE_FENCE), JSON.stringify({ version: 1, isolatedValidation: true, executorStart: false }), { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(stageToken, 0o600);
    try {
      fs.mkdirSync(targetData, { mode: 0o700 });
      createdTarget = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    realDirectory(targetData);
    if (fs.readdirSync(targetData).length) fail("restore_target_not_empty");
    releaseLock = acquireMaintenanceLock(targetData);
    for (const name of fs.readdirSync(stageData)) {
      const destination = path.join(targetData, name);
      fs.renameSync(path.join(stageData, name), destination);
      committed.push(destination);
    }
    fs.copyFileSync(stageToken, targetToken, fs.constants.COPYFILE_EXCL);
    createdToken = true;
    if (process.platform !== "win32") fs.chmodSync(targetToken, 0o600);
    completed = true;
    return { dataDir: targetData, tokenFile: targetToken, files: verified.manifest.data.filter((entry) => entry.type === "file").length + 1 };
  } catch (error) {
    if (createdToken) fs.rmSync(targetToken, { force: true });
    for (const entry of committed) fs.rmSync(entry, { recursive: true, force: true });
    fs.rmSync(stageData, { recursive: true, force: true });
    fs.rmSync(stageToken, { force: true });
    throw error;
  } finally {
    releaseLock?.();
    if (!completed && createdTarget && releaseLock) fs.rmSync(targetData, { recursive: true, force: true });
  }
}

function checkClock() {
  if (process.platform !== "linux") return { synchronized: false, source: "unsupported" };
  try {
    const output = execFileSync("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { synchronized: output === "yes", source: "timedatectl" };
  } catch { return { synchronized: false, source: "timedatectl_unavailable" }; }
}

async function readHealth(url, timeoutMs = 5000) {
  const target = new URL(url);
  if (!(["http:", "https:"].includes(target.protocol)) || target.username || target.password || target.search || target.hash || target.pathname !== "/healthz") fail("health_url_invalid");
  if (target.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) fail("health_url_must_use_https");
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(target, { timeout: timeoutMs, headers: { accept: "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(new Error("health_response_too_large")); });
      response.on("end", () => {
        let json;
        try { json = JSON.parse(body); } catch { return reject(new Error("health_response_invalid")); }
        if (response.statusCode !== 200 || json.healthy !== true || json.protocol !== 1) return reject(new Error("health_check_failed"));
        resolve({ healthy: true, protocol: json.protocol });
      });
    });
    request.on("timeout", () => request.destroy(new Error("health_timeout")));
    request.on("error", reject);
  });
}

function checkDataDirectory(dir, minimumFreeBytes = 1024 * 1024 * 1024) {
  const resolved = realDirectory(dir);
  const stat = fs.statSync(resolved);
  if (process.platform !== "win32" && (stat.mode & 0o077)) fail("data_directory_permissions_invalid");
  const probe = path.join(resolved, `.operations-write-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(probe, "wx", 0o600);
  fs.closeSync(fd);
  fs.unlinkSync(probe);
  const disk = fs.statfsSync(resolved);
  const freeBytes = disk.bavail * disk.bsize;
  if (freeBytes < minimumFreeBytes) fail("disk_space_below_minimum");
  return { path: resolved, freeBytes };
}

function checkTokenFile(file) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 32) fail("token_file_invalid");
  if (process.platform !== "win32" && (stat.mode & 0o077)) fail("token_file_permissions_invalid");
  const fd = fs.openSync(resolved, "r");
  fs.closeSync(fd);
  return { path: resolved, private: true, bytes: stat.size };
}

async function preflight({ dataDir, tokenFile, healthUrl, minimumFreeBytes = 1024 * 1024 * 1024, clock = checkClock(), health = readHealth } = {}) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail("node_22_required");
  const data = checkDataDirectory(dataDir, minimumFreeBytes);
  const token = checkTokenFile(tokenFile);
  if (!clock.synchronized) fail("clock_not_verified_synchronized");
  const healthStatus = await health(healthUrl);
  return { nodeMajor: major, dataDirectory: data, tokenFile: token, clockSource: clock.source, health: healthStatus };
}

function monitorMetrics(dataDir, { minimumFreeBytes = 1024 * 1024 * 1024, minimumMemoryBytes = 256 * 1024 * 1024 } = {}) {
  const resolved = realDirectory(dataDir);
  const fsStats = fs.statfsSync(resolved);
  const freeBytes = fsStats.bavail * fsStats.bsize;
  const freeMemoryBytes = os.freemem();
  const load = os.loadavg();
  const alerts = [];
  if (freeBytes < minimumFreeBytes) alerts.push("disk_below_threshold");
  if (freeMemoryBytes < minimumMemoryBytes) alerts.push("memory_below_threshold");
  return { freeBytes, freeMemoryBytes, load, alerts };
}

module.exports = {
  backup, restore, verifyBackup, ensureNoLiveServiceLock, checkClock, readHealth,
  checkDataDirectory, checkTokenFile, preflight, monitorMetrics,
};
