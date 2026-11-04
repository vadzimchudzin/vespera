"use strict";

/* The crypto Up/Down windows on Polymarket, from Gamma: one series per asset and duration (btc-up-or-down-15m,
 * bitcoin… for some), the current and next windows of each series, their market data (tokens, fee schedule, tick,
 * minimum size, rewards, the resolution rule and source, priceToBeat/finalPrice) and, once a window is over, the
 * official result. Series give the windows directly, so 4-hour windows (aligned to ET, they move with daylight
 * saving), hourly and daily ones (named in ET) need no slug arithmetic.
 * Resolution rules seen on Gamma (2026-11):
 *   chainlink-twap60  5m, 15m, 4h: Chainlink TWAP-60 at the end second ≥ TWAP-60 at the start second → Up
 *   binance-1h        1h: the Binance 1-hour candle, close ≥ open → Up
 *   binance-1m-close  1d: close of the Binance 1-minute candle at the end (noon ET) vs the one at the start;
 *                     higher → Up, lower → Down, equal → 50-50 */
const GAMMA = "https://gamma-api.polymarket.com";
const ASSETS = ["btc", "eth", "sol", "xrp"];
const TFS = ["5m", "15m", "1h", "4h", "1d"];
const TF_MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const SERIES_WORD = { "5m": "5m", "15m": "15m", "1h": "hourly", "4h": "4h", "1d": "daily" };
const NAMES = { btc: "bitcoin", eth: "ethereum", sol: "solana", xrp: "xrp", doge: "dogecoin", bnb: "bnb", hype: "hyperliquid" };

const SERIES_REFRESH_MS = 10 * 60000;   // re-read a series at least this often
const SERIES_MIN_MS = 15000;            // and never more often than this…
const SERIES_STALE_MS = 60000;          // …or than this while Gamma has no new window for it yet
const AHEAD = 2;                        // windows wanted per series: the current one and the next
const RESULT_POLL_MS = 30000;           // an ended window is asked for its result this often…
const RESULT_GIVE_UP_MS = 24 * 3600000; // …until this long after its end
const KEEP_BOOKS_MS = 5 * 60000;        // books of an ended window are kept this long
const FORGET_MS = 2 * 3600000;          // a settled window is forgotten this long after its end

const list = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
};
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function seriesSlugs(asset, tf) {
  const word = SERIES_WORD[tf];
  return [...new Set([`${asset}-up-or-down-${word}`, `${NAMES[asset] || asset}-up-or-down-${word}`])];
}

function ruleOf(m, ev, tf) {
  const src = String(m.resolutionSource || ev.resolutionSource || ""), text = String(m.description || ev.description || "");
  const cfg = m.cryptoMarketConfig || ev.cryptoMarketConfig || {};
  if (/chain\.link/i.test(src) && (cfg.twapEnabled === true || /time-weighted average price|twap/i.test(text)) && (cfg.twapLookbackSeconds == null || Number(cfg.twapLookbackSeconds) === 60)) return "chainlink-twap60";
  if (/binance\.com/i.test(src) && /1 hour candle/i.test(text) && tf === "1h") return "binance-1h";
  if (/binance\.com/i.test(src) && /1 minute candle/i.test(text) && tf === "1d") return "binance-1m-close";
  return "unknown";
}

// Closed with terminal prices: Up, Down or 50-50; otherwise no result yet.
function officialOutcome(m, iu, idn) {
  if (!m.closed) return null;
  const p = list(m.outcomePrices).map(Number);
  if (p[iu] === 1 && p[idn] === 0) return "Up";
  if (p[iu] === 0 && p[idn] === 1) return "Down";
  if (p[iu] === 0.5 && p[idn] === 0.5) return "50-50";
  return null;
}

// A Gamma event of an Up/Down series → the window record kept and written to the meta stream (null if malformed).
function windowOf(ev, series) {
  const m = ev && Array.isArray(ev.markets) ? ev.markets[0] : null;
  if (!m || !ev.slug) return null;
  const outcomes = list(m.outcomes).map((o) => String(o).toLowerCase()), toks = list(m.clobTokenIds).map(String);
  const iu = outcomes.indexOf("up"), idn = outcomes.indexOf("down");
  if (iu < 0 || idn < 0 || toks.length !== 2 || toks.some((t) => !/^\d+$/.test(t))) return null;
  const start = Date.parse(m.eventStartTime || ev.startTime || ""), end = Date.parse(m.endDate || ev.endDate || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const meta = ev.eventMetadata || m.eventMetadata || {};
  return {
    slug: String(ev.slug), asset: series.asset, tf: series.tf, series: series.slug, eventId: String(ev.id), marketId: String(m.id), conditionId: String(m.conditionId || ""),
    question: String(m.question || ev.title || "").slice(0, 200), up: toks[iu], down: toks[idn], start, end, rule: ruleOf(m, ev, series.tf),
    resolutionSource: m.resolutionSource || ev.resolutionSource || null,
    fee: m.feeSchedule || null, feeType: m.feeType ?? null, feesEnabled: m.feesEnabled ?? null, makerBaseFee: num(m.makerBaseFee), takerBaseFee: num(m.takerBaseFee),
    makerRebatesFeeShareBps: num(m.makerRebatesFeeShareBps), tick: num(m.orderPriceMinTickSize), minSize: num(m.orderMinSize),
    rewards: { minSize: num(m.rewardsMinSize), maxSpread: num(m.rewardsMaxSpread), clob: m.clobRewards ?? null, holding: m.holdingRewardsEnabled ?? null },
    twap: m.cryptoMarketConfig || ev.cryptoMarketConfig || null, negRisk: !!m.negRisk,
    ptb: num(meta.priceToBeat), fin: num(meta.finalPrice),
    accepting: m.acceptingOrders !== false, closed: !!m.closed, outcome: officialOutcome(m, iu, idn), uma: m.umaResolutionStatus || null,
    closedTime: m.closedTime || null,
  };
}

// The fields whose change is worth a new meta line.
const signature = (w) => JSON.stringify([w.ptb, w.fin, w.closed, w.outcome, w.accepting, w.fee, w.rewards, w.tick, w.minSize, w.uma, w.rule]);

class Windows {
  constructor({ fetchJson, now = Date.now, assets = ASSETS, tfs = TFS, onWindow = () => {}, onSeries = () => {}, onError = () => {}, concurrency = 4 }) {
    Object.assign(this, { fetchJson, now, assets, tfs, onWindow, onSeries, onError, concurrency });
    this.series = [];
    for (const asset of assets) for (const tf of tfs) this.series.push({ asset, tf, slugs: seriesSlugs(asset, tf), id: null, slug: null, triedAt: 0, syncedAt: 0, errors: 0 });
    this.windows = new Map();   // slug → window
    this.sigs = new Map();
    this.resultAt = 0;
    this.busy = null;
    this.calls = 0;
    this.errors = 0;
  }

  // Starts one round of Gamma requests if anything is due and none is running; resolves when it is done.
  step(now = this.now()) {
    if (this.busy) return this.busy;
    const jobs = [];
    for (const s of this.series) {
      if (!s.id) { if (now - s.triedAt >= 60000 || !s.triedAt) jobs.push(() => this._resolve(s)); continue; }
      if (now - s.syncedAt < (s.stale ? SERIES_STALE_MS : SERIES_MIN_MS)) continue;
      const ahead = [...this.windows.values()].filter((w) => w.series === s.slug && w.end > now + 30000).length;
      if (ahead < AHEAD || now - s.syncedAt >= SERIES_REFRESH_MS) jobs.push(() => this._sync(s));
    }
    const waiting = [...this.windows.values()].filter((w) => w.end <= now && w.outcome == null && now - w.end < RESULT_GIVE_UP_MS);
    if (waiting.length && now - this.resultAt >= RESULT_POLL_MS) {
      this.resultAt = now;
      for (let i = 0; i < waiting.length; i += 20) { const slugs = waiting.slice(i, i + 20).map((w) => w.slug); jobs.push(() => this._results(slugs)); }
    }
    for (const [slug, w] of this.windows) if (now - w.end > FORGET_MS && (w.outcome != null || now - w.end >= RESULT_GIVE_UP_MS)) { this.windows.delete(slug); this.sigs.delete(slug); }
    if (!jobs.length) return Promise.resolve();
    const run = async () => {
      const queue = jobs.slice();
      const worker = async () => { while (queue.length) await queue.shift()().catch((e) => this._error(e)); };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    };
    this.busy = run().finally(() => { this.busy = null; });
    return this.busy;
  }

  // Tokens whose books are recorded: per series the current and the next window, and windows ended a moment ago
  // (pick: only the windows it accepts, e.g. one CLOB shard's).
  tokens(now = this.now(), pick = null) {
    const out = new Set();
    const bySeries = new Map();
    for (const w of this.windows.values()) {
      if (pick && !pick(w)) continue;
      if (w.end <= now) { if (now - w.end <= KEEP_BOOKS_MS) { out.add(w.up); out.add(w.down); } continue; }
      if (!bySeries.has(w.series)) bySeries.set(w.series, []);
      bySeries.get(w.series).push(w);
    }
    for (const ws of bySeries.values()) for (const w of ws.sort((a, b) => a.end - b.end).slice(0, AHEAD)) { out.add(w.up); out.add(w.down); }
    return out;
  }

  conditions() { return new Set([...this.windows.values()].map((w) => w.conditionId).filter(Boolean)); }

  status(now = this.now()) {
    return { series: this.series.filter((s) => s.id).length, seriesWanted: this.series.length, windows: this.windows.size,
      waitingResult: [...this.windows.values()].filter((w) => w.end <= now && w.outcome == null).length, calls: this.calls, errors: this.errors };
  }

  _error(e) { this.errors += 1; this.onError(e); }

  async _get(url) { this.calls += 1; return this.fetchJson(url); }

  async _resolve(s) {
    s.triedAt = this.now();
    for (const slug of s.slugs) {
      const rows = await this._get(`${GAMMA}/series?slug=${encodeURIComponent(slug)}`);
      const row = Array.isArray(rows) ? rows.find((r) => r && r.slug === slug) : null;
      if (row && row.id != null) {
        s.id = String(row.id);
        s.slug = slug;
        this.onSeries({ asset: s.asset, tf: s.tf, slug, id: s.id, recurrence: row.recurrence || null, title: row.title || null });
        return this._sync(s);
      }
    }
    s.errors += 1;
  }

  async _sync(s) {
    const now = this.now();
    s.syncedAt = now;
    const url = `${GAMMA}/events?series_id=${encodeURIComponent(s.id)}&closed=false&end_date_min=${encodeURIComponent(new Date(now).toISOString())}` +
      `&order=endDate&ascending=true&limit=${AHEAD + 1}`;
    const events = await this._get(url);
    let fresh = 0;
    for (const ev of Array.isArray(events) ? events : []) if (this._take(ev, s) === "new") fresh += 1;
    s.stale = fresh === 0;
  }

  async _results(slugs) {
    const events = await this._get(`${GAMMA}/events?${slugs.map((x) => `slug=${encodeURIComponent(x)}`).join("&")}&limit=${slugs.length}`);
    for (const ev of Array.isArray(events) ? events : []) {
      const known = this.windows.get(ev && ev.slug);
      if (known) this._take(ev, this.series.find((s) => s.slug === known.series) || { asset: known.asset, tf: known.tf, slug: known.series });
    }
  }

  _take(ev, s) {
    const w = windowOf(ev, { asset: s.asset, tf: s.tf, slug: s.slug });
    if (!w) return null;
    const known = this.windows.has(w.slug);
    this.windows.set(w.slug, w);
    const sig = signature(w);
    if (this.sigs.get(w.slug) !== sig) {
      this.sigs.set(w.slug, sig);
      this.onWindow(w);
    }
    return known ? "known" : "new";
  }
}

module.exports = { Windows, windowOf, officialOutcome, ruleOf, seriesSlugs, GAMMA, ASSETS, TFS, TF_MS, NAMES, AHEAD, KEEP_BOOKS_MS, RESULT_POLL_MS };
