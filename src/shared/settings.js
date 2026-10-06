(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VesperaSettings = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_FIXED_STAKES = [1, 2, 4, 8, 16, 32];
  const DEFAULTS = {
    baseUsd: "1.00",
    maxSteps: 6,
    maxStakeUsd: 0,
    maxSeriesLossUsd: 0,
    dailyLossLimitUsd: 0,
    maxEntryPrice: 1,
    minOpeningAtr: 0,
    minCrossTicks: 0,
    confirmCount: 0,
    fastPeriod: 20,
    slowPeriod: 200,
    refreshMs: 100,
    sizingMode: "double",
    maType: "SMA",
    dryRun: true,
    fullBodyOnS: false,
    notificationsEnabled: true,
    fixedStakes: DEFAULT_FIXED_STAKES,
  };

  const LIMITS = Object.freeze({
    baseUsd: Object.freeze({ min: 0.01, max: 1000000, step: 0.01, default: "1.00" }),
    maxSteps: Object.freeze({ min: 1, max: 20, step: 1, default: 6 }),
    maxStakeUsd: Object.freeze({ min: 0, max: 1e9, step: 0.01, default: 0 }),
    maxSeriesLossUsd: Object.freeze({ min: 0, max: 1e9, step: 0.01, default: 0 }),
    dailyLossLimitUsd: Object.freeze({ min: 0, max: 1e9, step: 0.01, default: 0 }),
    maxEntryPrice: Object.freeze({ min: 0.05, max: 1, step: 0.01, default: 1 }),
    minOpeningAtr: Object.freeze({ min: 0, max: 2, step: 0.05, default: 0 }),
    minCrossTicks: Object.freeze({ min: 0, max: 2000, step: 1, default: 0 }),
    confirmCount: Object.freeze({ min: 0, max: 10, step: 1, default: 0 }),
    fastPeriod: Object.freeze({ min: 2, max: 200, step: 1, default: 20 }),
    slowPeriod: Object.freeze({ min: 5, max: 500, step: 1, default: 200 }),
    refreshMs: Object.freeze({ min: 1, max: 2000, step: 1, default: 100 }),
    fixedStakes: Object.freeze({ minLength: 1, maxLength: 20, min: 0.01, max: 1000000, step: 0.01, default: DEFAULT_FIXED_STAKES }),
  });
  const RISK_FIELDS = Object.freeze([
    "baseUsd",
    "maxSteps",
    "sizingMode",
    "fixedStakes",
    "maxStakeUsd",
    "maxSeriesLossUsd",
  ]);
  const NUMERIC_FIELDS = [
    "maxSteps", "maxStakeUsd", "maxSeriesLossUsd", "dailyLossLimitUsd", "maxEntryPrice",
    "minOpeningAtr", "minCrossTicks", "confirmCount", "fastPeriod", "slowPeriod", "refreshMs",
  ];
  const BOOLEAN_FIELDS = ["dryRun", "fullBodyOnS", "notificationsEnabled"];
  const ENUMS = { sizingMode: ["double", "fixed", "recover"], maType: ["SMA", "EMA"] };

  function invalid(field, message) {
    const error = new Error(message || `Invalid setting: ${field}`);
    error.code = "invalid_settings";
    error.field = field;
    return error;
  }

  function numberValue(value) {
    if (typeof value !== "number" && typeof value !== "string") return NaN;
    if (typeof value === "string" && value.trim() === "") return NaN;
    return Number(value);
  }

  function validNumeric(field, value) {
    const limits = LIMITS[field];
    const n = numberValue(value);
    if (!Number.isFinite(n) || n < limits.min || n > limits.max) return false;
    const step = limits.step;
    return Math.abs((n - limits.min) / step - Math.round((n - limits.min) / step)) < 1e-7;
  }

  function normalizedNumeric(field, value, strict, fallback) {
    const limits = LIMITS[field];
    let n = numberValue(value);
    if (strict && !validNumeric(field, value)) throw invalid(field);
    if (!Number.isFinite(n)) n = numberValue(fallback);
    if (!Number.isFinite(n)) n = limits.default;
    n = Math.min(limits.max, Math.max(limits.min, n));
    n = limits.min + Math.round((n - limits.min) / limits.step) * limits.step;
    if (field === "minOpeningAtr" || field === "maxEntryPrice" || field.endsWith("Usd")) {
      n = Number(n.toFixed(2));
    }
    return field === "baseUsd" ? n.toFixed(2) : n;
  }

  function parseFixedStakes(value) {
    let values;
    if (Array.isArray(value)) values = value;
    else if (typeof value === "string") values = value.split(/[,;\n]/).map((item) => item.trim());
    else return null;
    if (values.length < LIMITS.fixedStakes.minLength || values.length > LIMITS.fixedStakes.maxLength) return null;
    const stakes = values.map((item) => numberValue(item));
    if (stakes.some((n) => !Number.isFinite(n) || n < LIMITS.fixedStakes.min || n > LIMITS.fixedStakes.max || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7)) return null;
    return stakes.map((n) => Number(n.toFixed(2)));
  }

  function normalizedFixedStakes(value, strict, fallback) {
    const parsed = parseFixedStakes(value);
    if (strict && !parsed) throw invalid("fixedStakes");
    if (parsed) return parsed;
    return parseFixedStakes(fallback) || DEFAULT_FIXED_STAKES.slice();
  }

  function normalizedBoolean(field, value, strict, fallback) {
    if (typeof value === "boolean") return value;
    if (strict) throw invalid(field);
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    return typeof fallback === "boolean" ? fallback : DEFAULTS[field];
  }

  function normalizeSettings(input, current = {}, { strict = true } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      if (strict) throw invalid("settings");
      input = {};
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
    const out = {};
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (key === "baseUsd") {
        out[key] = normalizedNumeric(key, value, strict, current[key] ?? DEFAULTS[key]);
      } else if (NUMERIC_FIELDS.includes(key)) {
        out[key] = normalizedNumeric(key, value, strict, current[key] ?? DEFAULTS[key]);
      } else if (key === "fixedStakes") {
        out[key] = normalizedFixedStakes(value, strict, current[key]);
      } else if (BOOLEAN_FIELDS.includes(key)) {
        out[key] = normalizedBoolean(key, value, strict, current[key]);
      } else if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
        if (ENUMS[key].includes(value)) out[key] = value;
        else if (strict) throw invalid(key);
        else out[key] = ENUMS[key].includes(current[key]) ? current[key] : DEFAULTS[key];
      } else {
        out[key] = value;
      }
    }

    const effective = { ...DEFAULTS, ...current, ...out };
    const fastWasSet = Object.prototype.hasOwnProperty.call(input, "fastPeriod");
    const slowWasSet = Object.prototype.hasOwnProperty.call(input, "slowPeriod");
    if ((fastWasSet || slowWasSet) && Number(effective.slowPeriod) <= Number(effective.fastPeriod)) {
      const raised = Number(effective.fastPeriod) + 1;
      if (raised > LIMITS.slowPeriod.max) {
        if (strict) throw invalid("slowPeriod", "slowPeriod must be greater than fastPeriod");
        out.fastPeriod = LIMITS.fastPeriod.max - 1;
        out.slowPeriod = LIMITS.slowPeriod.max;
      } else {
        out.slowPeriod = raised;
      }
    }

    const fixedWasSet = ["sizingMode", "fixedStakes", "maxSteps", "baseUsd"].some((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (fixedWasSet && effective.sizingMode === "fixed") {
      const stakes = normalizedFixedStakes(effective.fixedStakes, false, DEFAULTS.fixedStakes);
      out.maxSteps = stakes.length;
      out.baseUsd = stakes[0].toFixed(2);
    }
    return out;
  }

  return { LIMITS, normalizeSettings, RISK_FIELDS };
});
