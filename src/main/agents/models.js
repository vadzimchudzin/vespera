"use strict";

// Probability models and title parsers for the model agents. Pure functions: no network, no clock.

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// Standard normal CDF (Abramowitz–Stegun 26.2.17, |error| < 7.5e-8).
function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// --- crypto: driftless (martingale) lognormal price ------------------------------------------------------------
function probAbove(S, K, sigma, tauMs) {
  if (!(S > 0 && K > 0) || !(sigma > 0)) return null;
  if (tauMs <= 0) return S > K ? 1 : 0;
  const st = sigma * Math.sqrt(tauMs / YEAR_MS);
  return normCdf((Math.log(S / K) - st * st / 2) / st);
}
function probBetween(S, lo, hi, sigma, tauMs) {
  const a = lo == null ? 1 : probAbove(S, lo, sigma, tauMs);
  const b = hi == null ? 0 : probAbove(S, hi, sigma, tauMs);
  if (a == null || b == null) return null;
  return Math.max(0, a - b);
}
// P(the price touches K before the horizon): reflection principle for log price with drift −σ²/2.
function probTouch(S, K, sigma, tauMs) {
  if (!(S > 0 && K > 0) || !(sigma > 0)) return null;
  if (K === S) return 1;
  const st = sigma * Math.sqrt(Math.max(0, tauMs) / YEAR_MS);
  if (!(st > 0)) return 0;
  const m = -st * st / 2;
  if (K > S) {
    const b = Math.log(K / S);
    return Math.min(1, normCdf((-b + m) / st) + (S / K) * normCdf((-b - m) / st));
  }
  const a = Math.log(S / K);
  return Math.min(1, normCdf((-a - m) / st) + (S / K) * normCdf((-a + m) / st));
}

const ASSETS = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", xrp: "XRP" };
function parseCryptoEvent(title) {
  const t = String(title || "").toLowerCase().trim();
  let m;
  if ((m = /^(bitcoin|ethereum|solana|xrp) above ___ on .+$/.exec(t))) return { asset: ASSETS[m[1]], kind: "above" };
  if ((m = /^(bitcoin|ethereum|solana|xrp) price on .+$/.exec(t))) return { asset: ASSETS[m[1]], kind: "range" };
  if ((m = /^what price will (bitcoin|ethereum|solana|xrp) hit\b.*$/.exec(t))) return { asset: ASSETS[m[1]], kind: "touch" };
  return null;
}
function amount(text) {
  const s = String(text).replace(/[$,\s]/g, "");
  const k = /k$/i.test(s);
  const v = Number(s.replace(/k$/i, ""));
  return Number.isFinite(v) && v > 0 ? v * (k ? 1000 : 1) : null;
}
// "70,000" | "↑ 100,000" | "↓ 60,000" | "<72,000" | "72,000-74,000" | ">90,000"
function parseStrike(label) {
  const s = String(label || "").replace(/\s+/g, "").replace(/\$/g, "");
  let m;
  if ((m = /^↑([\d.,]+k?)$/i.exec(s))) return { dir: "up", k: amount(m[1]) };
  if ((m = /^↓([\d.,]+k?)$/i.exec(s))) return { dir: "down", k: amount(m[1]) };
  if ((m = /^<([\d.,]+k?)$/i.exec(s))) return { lo: null, hi: amount(m[1]) };
  if ((m = /^>([\d.,]+k?)$/i.exec(s))) return { lo: amount(m[1]), hi: null };
  if ((m = /^([\d.,]+k?)-([\d.,]+k?)$/i.exec(s))) return { lo: amount(m[1]), hi: amount(m[2]) };
  if ((m = /^([\d.,]+k?)$/i.exec(s))) return { k: amount(m[1]) };
  return null;
}

// "by September 30, 2026" | "June 30" | "March 31, 2027": a date; a missing year comes from the event's end.
function parseDateLabel(label, endMs) {
  const m = /(?:^|\bby\s+)([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\s*$/i.exec(String(label || "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : new Date(endMs || Date.now()).getUTCFullYear();
  let at = Date.UTC(year, month, day, 23, 59);
  if (!m[3] && endMs && at > endMs + 2 * 86400000) at = Date.UTC(--year, month, day, 23, 59);
  return Number.isFinite(at) ? at : null;
}

// --- weather: daily high / low at an airport METAR station --------------------------------------------------------
function parseWeatherEvent(ev) {
  const m = /^(highest|lowest) temperature in (.+?) on ([a-z]+) (\d{1,2})\??$/i.exec(String(ev?.title || "").trim());
  if (!m) return null;
  const station = /\(([A-Z]{4})\)/.exec(ev.description || "");
  if (!station) return null;   // e.g. Hong Kong resolves on the Observatory's daily extract, not on a METAR station
  const month = MONTHS.indexOf(m[3].toLowerCase());
  if (month < 0) return null;
  const year = Number(/-(\d{4})$/.exec(ev.slug || "")?.[1]) || new Date(ev.endDate || Date.now()).getUTCFullYear();
  const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(Number(m[4])).padStart(2, "0")}`;
  const buckets = [];
  let unit = null;
  for (const market of ev.markets || []) {
    const b = parseBucket(market.label);
    if (!b) continue;
    if (unit && b.unit !== unit) return null;
    unit = b.unit;
    buckets.push({ market, lo: b.lo, hi: b.hi });
  }
  if (buckets.length < 2) return null;
  return { kind: m[1].toLowerCase() === "highest" ? "max" : "min", city: m[2], icao: station[1], date, unit, buckets };
}
// "-2°C or below" | "6°C" | "48-49°F" | "66°F or higher"
function parseBucket(label) {
  const s = String(label || "").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  let m;
  if ((m = /^(-?\d+) ?°([CF]) or (?:below|lower|less)$/i.exec(s))) return { lo: -Infinity, hi: Number(m[1]), unit: m[2].toUpperCase() };
  if ((m = /^(-?\d+) ?°([CF]) or (?:higher|above|more)$/i.exec(s))) return { lo: Number(m[1]), hi: Infinity, unit: m[2].toUpperCase() };
  if ((m = /^(-?\d+) ?- ?(-?\d+) ?°([CF])$/i.exec(s))) return { lo: Number(m[1]), hi: Number(m[2]), unit: m[3].toUpperCase() };
  if ((m = /^(-?\d+) ?°([CF])$/i.exec(s))) return { lo: Number(m[1]), hi: Number(m[1]), unit: m[2].toUpperCase() };
  return null;
}

// METAR temperature: the hourly remark T-group (tenths °C) when present, else the whole degrees of the body.
function metarTemp(row) {
  const raw = String(row?.rawOb || "");
  const t = / T([01])(\d{3})[01]\d{3}\b/.exec(raw);
  if (t) return (t[1] === "1" ? -1 : 1) * Number(t[2]) / 10;
  const v = Number(row?.temp);
  return Number.isFinite(v) ? v : null;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Probabilities of the buckets of one day's high or low.
 *   observed: the extreme of the routine observations already made on that local date;
 *   forecast: each ensemble member's extreme over the date's remaining hours, less the model's recent bias at the
 *   station (median of model − observation over the past day), blurred by σ = 0.7 °C + 0.35 °C per day of lead;
 *   decided: the bucket is settled by the observations alone (out of reach or certain, half a degree of margin).
 * The qualifying value rounds half up to whole degrees of the market's unit, so bucket [lo, hi] is the interval
 * [lo − 0.5, hi + 0.5) in that unit.
 */
function weatherProbabilities({ kind, date, unit, buckets, times, members, offsetSec, obs, now }) {
  const localDate = (t) => new Date(t + offsetSec * 1000).toISOString().slice(0, 10);
  const utcOf = (local) => Date.parse(`${local}:00Z`) - offsetSec * 1000;
  const seen = (obs || []).filter((o) => o.t <= now && localDate(o.t) === date).map((o) => o.c);
  const observed = seen.length ? (kind === "max" ? Math.max(...seen) : Math.min(...seen)) : null;
  const remaining = [];
  const past = [];
  for (let i = 0; i < times.length; i++) {
    const at = utcOf(times[i]);
    if (times[i].slice(0, 10) === date && at > now) remaining.push(i);
    else if (at <= now && at > now - 30 * 3600000) past.push([i, at]);
  }
  const diffs = [];
  for (const o of obs || []) {
    const hit = past.find(([, at]) => Math.abs(at - o.t) <= 30 * 60000);
    if (!hit) continue;
    const values = members.map((series) => series[hit[0]]).filter(Number.isFinite);
    if (values.length) diffs.push(values.reduce((a, b) => a + b, 0) / values.length - o.c);
  }
  const bias = diffs.length >= 6 ? Math.max(-4, Math.min(4, median(diffs))) : 0;
  const values = [];
  if (remaining.length) {
    for (const series of members) {
      const xs = remaining.map((i) => series[i]).filter(Number.isFinite);
      if (xs.length === remaining.length) values.push((kind === "max" ? Math.max(...xs) : Math.min(...xs)) - bias);
    }
    if (values.length < 10) return null;
  } else if (observed == null) return null;
  const lead = remaining.length ? Math.max(0, (utcOf(times[remaining[remaining.length >> 1]]) - now) / 86400000) : 0;
  const sigma = 0.7 + 0.35 * lead;
  const toC = (u) => (unit === "F" ? (u - 32) * 5 / 9 : u);
  const below = (x) => {   // P(final < x), x in °C
    if (x === -Infinity) return 0;
    if (x === Infinity) return 1;
    if (!values.length) return observed < x ? 1 : 0;   // the day is over: the observed extreme is final
    const mean = (f) => values.reduce((s, v) => s + f(v), 0) / values.length;
    if (kind === "max") return (observed == null || observed < x ? 1 : 0) * mean((v) => normCdf((x - v) / sigma));
    return 1 - (observed == null || observed >= x ? 1 : 0) * mean((v) => 1 - normCdf((x - v) / sigma));
  };
  // Where the final value can still land, in °C: a high only rises from the observed one and a low only falls; once
  // the day is over it is the observed one. Half a degree either way covers reports in whole degrees.
  const range = observed == null ? null
    : !values.length ? [observed - 0.5, observed + 0.5] : kind === "max" ? [observed - 0.5, Infinity] : [-Infinity, observed + 0.5];
  const out = buckets.map((b) => {
    const a = b.lo === -Infinity ? -Infinity : toC(b.lo - 0.5);
    const c = b.hi === Infinity ? Infinity : toC(b.hi + 0.5);
    // decided: the observations alone settle the bucket (out of reach, or certain), whatever the forecast says
    const decided = Boolean(range && (range[1] < a || range[0] >= c || (range[0] >= a && (c === Infinity || range[1] < c))));
    return { market: b.market, p: Math.max(0, Math.min(1, below(c) - below(a))), decided };
  });
  return { buckets: out, observed, bias, sigma, members: values.length, remainingHours: remaining.length };
}

module.exports = {
  YEAR_MS, normCdf, probAbove, probBetween, probTouch, parseCryptoEvent, parseStrike, parseDateLabel,
  parseWeatherEvent, parseBucket, metarTemp, median, weatherProbabilities,
};
