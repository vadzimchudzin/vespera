"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeSettings } = require("../shared/settings");
const { TIMEFRAMES } = require("./markets");
const { listStrategies } = require("./strategies/catalog");
const { isSupportedMarket } = require("./brokers/polymarketMarkets");

const SETUP_FIELDS = Object.freeze([
  "strategyId", "symbol", "timeframe", "maType", "fastPeriod", "slowPeriod", "minOpeningAtr",
  "minCrossTicks", "confirmCount", "fullBodyOnS", "sizingMode", "fixedStakes", "baseUsd",
  "maxSteps", "maxStakeUsd", "maxSeriesLossUsd", "dailyLossLimitUsd", "maxEntryPrice",
]);
const SETUP_FIELD_SET = new Set(SETUP_FIELDS);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_SETUPS = 100;
const MAX_VERSIONS = 100;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(settings, signalTimeframe, marketTimeframe) {
  const body = { settings, signalTimeframe, marketTimeframe };
  return crypto.createHash("sha256").update(stable(body)).digest("hex");
}

function validateSetupSettings(input, { mode = "paper" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_setup");
  for (const key of Object.keys(input)) if (!SETUP_FIELD_SET.has(key)) throw fail("invalid_setup_field");
  if (Object.keys(input).length !== SETUP_FIELDS.length || SETUP_FIELDS.some((key) => !Object.hasOwn(input, key))) {
    throw fail("invalid_setup_field");
  }
  if (!listStrategies().some((row) => row.id === input.strategyId && row.enabled)) throw fail("unknown_strategy");
  if (typeof input.symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(input.symbol)) throw fail("unknown_symbol");
  if (!TIMEFRAMES.includes(input.timeframe)) throw fail("unknown_timeframe");
  if (mode === "auto" && !isSupportedMarket(input.symbol, input.timeframe)) {
    throw fail("market_unsupported_in_auto");
  }
  let normalized;
  try {
    normalized = normalizeSettings(input, {}, { strict: true });
  } catch (error) {
    throw fail(error.field ? `invalid_setup_${error.field}` : "invalid_setup");
  }
  for (const key of SETUP_FIELDS) {
    if (Object.hasOwn(normalized, key) && stable(normalized[key]) !== stable(input[key])) throw fail(`invalid_setup_${key}`);
  }
  return Object.fromEntries(SETUP_FIELDS.map((key) => [key, input[key]]));
}

function validateName(value) {
  if (typeof value !== "string") throw fail("invalid_setup_name");
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail("invalid_setup_name");
  return name;
}

function validateVersion(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      Object.keys(row).sort().join(",") !== ["createdAt", "fingerprint", "id", "marketTimeframe", "name", "settings", "signalTimeframe", "version"].sort().join(",") ||
      typeof row.id !== "string" || !/^[a-f0-9-]{36}$/.test(row.id) ||
      !Number.isInteger(row.version) || row.version < 1 || row.version > MAX_VERSIONS ||
      !Number.isFinite(Date.parse(row.createdAt)) || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
    throw fail("setup_store_corrupt");
  }
  const name = validateName(row.name);
  const settings = validateSetupSettings(row.settings);
  const { signalTimeframe, marketTimeframe } = row;
  if (!TIMEFRAMES.includes(signalTimeframe) || !TIMEFRAMES.includes(marketTimeframe) || signalTimeframe !== marketTimeframe ||
      settings.timeframe !== marketTimeframe || fingerprint(settings, signalTimeframe, marketTimeframe) !== row.fingerprint) {
    throw fail("setup_store_corrupt");
  }
  return { ...row, name, settings };
}

function validateLibrary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      !Array.isArray(value.setups) || value.setups.length > MAX_SETUPS ||
      !(value.activeSetup === null || (value.activeSetup && typeof value.activeSetup === "object" &&
        Object.keys(value.activeSetup).sort().join(",") === "id,version" && typeof value.activeSetup.id === "string" &&
        Number.isInteger(value.activeSetup.version) && value.activeSetup.version > 0))) throw fail("setup_store_corrupt");
  const ids = new Set();
  const setups = value.setups.map((setup) => {
    if (!setup || typeof setup !== "object" || Array.isArray(setup) ||
        Object.keys(setup).sort().join(",") !== "id,name,versions" ||
        typeof setup.id !== "string" || !/^[a-f0-9-]{36}$/.test(setup.id) || ids.has(setup.id) ||
        !Array.isArray(setup.versions) || !setup.versions.length || setup.versions.length > MAX_VERSIONS) throw fail("setup_store_corrupt");
    ids.add(setup.id);
    let expected = 1;
    const versions = setup.versions.map((row) => {
      const version = validateVersion(row);
      if (version.id !== setup.id || version.version !== expected++) throw fail("setup_store_corrupt");
      return version;
    });
    const name = validateName(setup.name);
    if (name !== versions.at(-1).name) throw fail("setup_store_corrupt");
    return { id: setup.id, name, versions };
  });
  if (value.activeSetup && !setups.some((setup) => setup.id === value.activeSetup.id && setup.versions.some((v) => v.version === value.activeSetup.version))) {
    throw fail("setup_store_corrupt");
  }
  return { version: 1, setups, activeSetup: value.activeSetup ? { ...value.activeSetup } : null };
}

function emptyLibrary() { return { version: 1, setups: [], activeSetup: null }; }

class SetupStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "setups.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.value = this._read();
  }

  _read() {
    let stat;
    try { stat = fs.lstatSync(this.file); } catch (error) {
      if (error.code === "ENOENT") return emptyLibrary();
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077)) || stat.size > MAX_FILE_BYTES) {
      throw fail("setup_store_permissions_invalid");
    }
    try { return validateLibrary(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
    catch (error) { if (error.code?.startsWith("setup_") || error.code?.startsWith("invalid_setup")) throw error; throw fail("setup_store_corrupt"); }
  }

  _write(next) {
    const validated = validateLibrary(next);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw fail("setup_limit");
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temporary, this.file);
      try {
        const dirFd = fs.openSync(this.dir, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (error) { if (process.platform !== "win32") throw error; }
      this.value = validated;
      return validated;
    } catch (error) {
      if (fd !== undefined && fd !== null) fs.closeSync(fd);
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  listSetups() {
    return this.value.setups.map((setup) => ({
      id: setup.id,
      name: setup.name,
      versions: setup.versions.map((row) => structuredClone(row)),
      latestVersion: setup.versions.at(-1).version,
    }));
  }

  getVersion(id, version) {
    const setup = this.value.setups.find((row) => row.id === id);
    return setup?.versions.find((row) => row.version === Number(version)) || null;
  }

  setActive(ref) {
    if (ref && !this.getVersion(ref.id, ref.version)) throw fail("setup_not_found");
    return this._write({ ...this.value, activeSetup: ref ? { id: ref.id, version: Number(ref.version) } : null });
  }

  _newVersion(name, settings, { id, signalTimeframe = settings.timeframe, marketTimeframe = settings.timeframe } = {}) {
    const canonical = validateSetupSettings(settings);
    if (signalTimeframe !== marketTimeframe || signalTimeframe !== canonical.timeframe) throw fail("timeframe_mismatch");
    const createdAt = new Date().toISOString();
    return {
      id: id || crypto.randomUUID(),
      version: 1,
      name: validateName(name),
      createdAt,
      fingerprint: fingerprint(canonical, signalTimeframe, marketTimeframe),
      settings: canonical,
      signalTimeframe,
      marketTimeframe,
    };
  }

  saveSetup({ name, id, settings, signalTimeframe, marketTimeframe, activate = false } = {}) {
    const cleanName = validateName(name);
    const canonical = validateSetupSettings(settings);
    const signalTf = signalTimeframe || canonical.timeframe;
    const marketTf = marketTimeframe || canonical.timeframe;
    if (signalTf !== marketTf || signalTf !== canonical.timeframe) throw fail("timeframe_mismatch");
    if (id != null && (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw fail("invalid_setup_id");
    const existing = id ? this.value.setups.find((row) => row.id === id) : null;
    if (id && !existing) throw fail("setup_not_found");
    if (!existing && this.value.setups.length >= MAX_SETUPS) throw fail("setup_limit");
    if (existing && existing.versions.length >= MAX_VERSIONS) throw fail("setup_version_limit");
    const version = {
      id: existing?.id || crypto.randomUUID(),
      version: (existing?.versions.length || 0) + 1,
      name: cleanName,
      createdAt: new Date().toISOString(),
      fingerprint: fingerprint(canonical, signalTf, marketTf),
      settings: canonical,
      signalTimeframe: signalTf,
      marketTimeframe: marketTf,
    };
    const setup = existing
      ? { id: existing.id, name: cleanName, versions: [...existing.versions, version] }
      : { id: version.id, name: cleanName, versions: [version] };
    const setups = existing ? this.value.setups.map((row) => row.id === id ? setup : row) : [...this.value.setups, setup];
    this._write({ ...this.value, setups, activeSetup: activate ? { id: version.id, version: version.version } : this.value.activeSetup });
    return structuredClone(version);
  }

  copySetup({ id, version, name } = {}) {
    const source = this.getVersion(id, version);
    if (!source) throw fail("setup_not_found");
    return this.saveSetup({ name: validateName(name), settings: source.settings,
      signalTimeframe: source.signalTimeframe, marketTimeframe: source.marketTimeframe });
  }

  exportSetup({ id, version } = {}) {
    const source = this.getVersion(id, version);
    if (!source) throw fail("setup_not_found");
    const json = JSON.stringify({ schemaVersion: 1, name: source.name, settings: source.settings,
      signalTimeframe: source.signalTimeframe, marketTimeframe: source.marketTimeframe }, null, 2);
    if (Buffer.byteLength(json) > MAX_IMPORT_BYTES) throw fail("setup_export_too_large");
    return { ok: true, json, name: source.name };
  }

  importSetup({ json } = {}) {
    if (typeof json !== "string" || Buffer.byteLength(json) > MAX_IMPORT_BYTES) throw fail("invalid_setup_import");
    let value;
    try { value = JSON.parse(json); } catch { throw fail("invalid_setup_import"); }
    const expected = ["marketTimeframe", "name", "schemaVersion", "settings", "signalTimeframe"].sort().join(",");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected || value.schemaVersion !== 1) {
      throw fail("invalid_setup_import");
    }
    const settings = validateSetupSettings(value.settings);
    if (value.signalTimeframe !== value.marketTimeframe || value.marketTimeframe !== settings.timeframe) throw fail("timeframe_mismatch");
    return this.saveSetup({ name: validateName(value.name), settings, signalTimeframe: value.signalTimeframe, marketTimeframe: value.marketTimeframe });
  }

  importLibrary(value) {
    const incoming = validateLibrary(value);
    if (!incoming.setups.length && incoming.activeSetup === null) return this._write({ ...this.value, activeSetup: null });
    const currentById = new Map(this.value.setups.map((row) => [row.id, row]));
    const merged = this.value.setups.map((row) => structuredClone(row));
    for (const setup of incoming.setups) {
      const current = currentById.get(setup.id);
      if (!current) {
        merged.push(structuredClone(setup));
        continue;
      }
      const shared = Math.min(current.versions.length, setup.versions.length);
      for (let index = 0; index < shared; index += 1) {
        if (stable(current.versions[index]) !== stable(setup.versions[index])) throw fail("setup_import_conflict");
      }
      const shorter = current.versions.length <= setup.versions.length ? current : setup;
      const longer = shorter === current ? setup : current;
      if (shorter.versions.length !== shared) throw fail("setup_import_conflict");
      if (longer.versions.length > MAX_VERSIONS) throw fail("setup_version_limit");
      const combined = { id: setup.id, name: longer.name, versions: structuredClone(longer.versions) };
      merged[merged.findIndex((row) => row.id === setup.id)] = combined;
    }
    if (merged.length > MAX_SETUPS) throw fail("setup_limit");
    const ref = incoming.activeSetup;
    if (ref && !merged.some((row) => row.id === ref.id && row.versions.some((version) => version.version === ref.version))) throw fail("setup_store_corrupt");
    return this._write({ version: 1, setups: merged, activeSetup: ref ? { ...ref } : null });
  }
}

function settingsFromEngine(engine) {
  const values = {
    ...engine.settings,
    strategyId: engine.strategyId,
    symbol: engine.settings.symbol,
    timeframe: engine.settings.timeframe,
    baseUsd: engine.risk.baseUsd.toFixed(2),
    maxSteps: engine.risk.maxSteps,
    sizingMode: engine.risk.sizingMode,
    fixedStakes: engine.risk.fixedStakes.slice(),
    maxStakeUsd: engine.risk.maxStakeUsd,
    maxSeriesLossUsd: engine.risk.maxSeriesLossUsd,
    dailyLossLimitUsd: engine.dailyLossLimit(),
    maxEntryPrice: Number(engine.settings.maxEntryPrice ?? 1),
  };
  return validateSetupSettings(Object.fromEntries(SETUP_FIELDS.map((key) => [key, values[key]])));
}

module.exports = { SetupStore, SETUP_FIELDS, settingsFromEngine, fingerprint, validateSetupSettings, MAX_IMPORT_BYTES };
