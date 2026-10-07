"use strict";

const crypto = require("crypto");
const { ResearchStore, MAX_RUNS, MAX_TRADES, MAX_DATA_BARS } = require("./researchStore");
const { MarketData } = require("./marketData");
const { INTERVAL_MS, fallbackTick } = require("./markets");
const { getStrategy } = require("./strategies/catalog");
const { Risk } = require("./risk");
const { PaperBroker } = require("./paperBroker");
const { computeStats } = require("./stats");
const { Decimal } = require("./money");
const { ASSUMED_PRICE, CRYPTO_TAKER_RATE, DEFAULT_EXPONENT } = require("./fees");
const { fingerprint, validateSetupSettings } = require("./setupStore");

const FEE_SCHEDULE = Object.freeze({ rate: CRYPTO_TAKER_RATE, exponent: DEFAULT_EXPONENT });
const STREAM_LIMIT = 10;

function fail(code) { const error = new Error(code); error.code = code; return error; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function setupCapture(version) {
  const settings = validateSetupSettings(version.settings);
  const computed = fingerprint(settings, version.signalTimeframe, version.marketTimeframe);
  if (computed !== version.fingerprint) throw fail("setup_store_corrupt");
  return {
    id: version.id, version: version.version, name: version.name,
    fingerprint: version.fingerprint, signalTimeframe: version.signalTimeframe,
    marketTimeframe: version.marketTimeframe, settings,
  };
}
function validateBalance(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 1_000_000_000) throw fail("invalid_starting_balance");
  return Decimal(n).toFixed(2);
}
function validateBars(input, timeframe, { now = Date.now() } = {}) {
  if (!Array.isArray(input) || input.length > MAX_DATA_BARS) throw fail("invalid_research_bars");
  const interval = INTERVAL_MS[timeframe];
  if (!interval) throw fail("unknown_timeframe");
  const bars = [];
  let prior = null;
  for (const source of input) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw fail("invalid_research_bar");
    const openTs = Number(source.openTs);
    const open = Number(source.open);
    const high = Number(source.high);
    const low = Number(source.low);
    const close = Number(source.close);
    const closeTs = source.closeTs == null ? openTs + interval - 1 : Number(source.closeTs);
    if (![openTs, open, high, low, close, closeTs].every(Number.isFinite) ||
        !Number.isSafeInteger(openTs) || openTs < 0 || openTs % interval !== 0 ||
        closeTs !== openTs + interval - 1 || Math.min(open, high, low, close) <= 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || low > high ||
        source.closed === false || closeTs > now ||
        (prior && openTs <= prior.openTs)) throw fail("invalid_research_bar");
    const volume = source.volume == null ? 0 : Number(source.volume);
    if (!Number.isFinite(volume) || volume < 0) throw fail("invalid_research_bar");
    const bar = { openTs, open, high, low, close, volume, closeTs, closed: true };
    bars.push(bar);
    prior = bar;
  }
  return bars;
}
function datasetHash(bars) { return crypto.createHash("sha256").update(stable(bars)).digest("hex"); }
function isContiguous(bars, index, timeframe, lookback) {
  const interval = INTERVAL_MS[timeframe];
  const from = Math.max(1, index - lookback + 1);
  for (let i = from; i <= index; i += 1) if (bars[i].openTs - bars[i - 1].openTs !== interval) return false;
  return true;
}
function makeRisk(settings) {
  return new Risk({
    baseUsd: settings.baseUsd, maxSteps: settings.maxSteps, sizingMode: settings.sizingMode,
    maxStakeUsd: settings.maxStakeUsd, fixedStakes: settings.fixedStakes,
    maxSeriesLossUsd: settings.maxSeriesLossUsd,
  });
}
function makeStats(run) {
  const entries = run.trades.map((trade) => ({ ...trade, type: "settled", book: "paper", settlementStatus: "final" }));
  return computeStats(entries, { book: "paper", maxSteps: run.setup.settings.maxSteps });
}

class ReplayBook {
  constructor({ setup, startingBalance, run, onChange = () => {} }) {
    this.setup = setup;
    this.settings = setup.settings;
    this.run = run;
    this.onChange = onChange;
    this.risk = makeRisk(this.settings);
    this.broker = new PaperBroker({ startingBalance });
    if (run?.paperState) this.restore(run.paperState);
    this.bars = run?.mode === "paper" ? (run.bars || []) : [];
  }

  restore(state) {
    this.broker.startingBalance = Decimal(state.startingBalance);
    this.broker.balance = Decimal(state.balance);
    this.broker.openBet = state.openBet ? structuredClone(state.openBet) : null;
    this.broker.history = structuredClone(this.run.trades || []);
    Object.assign(this.risk, state.risk);
  }

  state() {
    return {
      startingBalance: this.broker.startingBalance.toFixed(2),
      balance: this.broker.balance.toFixed(2),
      openBet: this.broker.openBet ? structuredClone(this.broker.openBet) : null,
      risk: {
        step: this.risk.step, consecutiveLosses: this.risk.consecutiveLosses,
        seriesLossUsd: this.risk.seriesLossUsd, halted: this.risk.halted,
        lotConfirmed: this.risk.lotConfirmed,
      },
    };
  }

  _dailyPnl(ts) {
    const day = new Date(ts).toISOString().slice(0, 10);
    return this.run.trades.reduce((sum, trade) => new Date(trade.ts).toISOString().slice(0, 10) === day ? sum + Number(trade.pnl) : sum, 0);
  }

  async advance(bar, { canEnter = true } = {}) {
    const validated = validateBars([bar], this.settings.timeframe)[0];
    const last = this.bars.at(-1);
    if (last && validated.openTs <= last.openTs) return null;
    this.bars.push(validated);
    if (this.bars.length > MAX_DATA_BARS) this.bars.splice(0, this.bars.length - MAX_DATA_BARS);
    const interval = INTERVAL_MS[this.settings.timeframe];
    const open = this.broker.openBet;
    if (open && validated.openTs === open.roundOpenTs && validated.closeTs === open.roundCloseTs) {
      const settled = this.broker.settle(validated);
      if (settled) {
        settled.ts = validated.closeTs;
        settled.settledAt = validated.closeTs;
        settled.holdMs = validated.closeTs - settled.placedAt;
        settled.book = "paper";
        settled.type = "settled";
        settled.settlementStatus = "final";
        settled.setup = { id: this.setup.id, version: this.setup.version, name: this.setup.name, fingerprint: this.setup.fingerprint };
        if (settled.status === "win") this.risk.onWin();
        else this.risk.onLoss(Number(settled.sizeUsd) + Number(settled.feeUsd));
        this.run.trades.push(settled);
        this.onChange(this.run);
      }
    }
    const index = this.bars.length - 1;
    const lookback = Math.max(this.settings.slowPeriod, this.settings.confirmCount + 2);
    if (!canEnter || this.run.trades.length >= MAX_TRADES || this.broker.openBet || !this.risk.canOpen() || !isContiguous(this.bars, index, this.settings.timeframe, lookback)) return null;
    const dailyLimit = Number(this.settings.dailyLossLimitUsd) || 0;
    if (dailyLimit > 0 && -this._dailyPnl(validated.closeTs) >= dailyLimit - 1e-9) return null;
    if (!this.risk.budgetAllows(ASSUMED_PRICE, FEE_SCHEDULE)) return null;
    const strategy = getStrategy(this.settings.strategyId);
    const signal = strategy.evaluate(this.bars, index, {
      minOpeningAtr: this.settings.minOpeningAtr,
      minCrossTicks: this.settings.minCrossTicks,
      tickSize: this.run.tickSize || fallbackTick(this.settings.symbol),
      confirmCount: this.settings.confirmCount,
      fastPeriod: this.settings.fastPeriod,
      slowPeriod: this.settings.slowPeriod,
      fullBodyOnS: this.settings.fullBodyOnS,
      maType: this.settings.maType,
    });
    if (!signal.signal || ASSUMED_PRICE > Number(this.settings.maxEntryPrice)) return signal;
    const sizeUsd = this.risk.size(ASSUMED_PRICE, FEE_SCHEDULE).toFixed(2);
    const prospectiveCost = Math.ceil((Number(sizeUsd) + this.broker.feeOn(sizeUsd, ASSUMED_PRICE, FEE_SCHEDULE)) * 100 - 1e-9) / 100;
    if (dailyLimit > 0 && prospectiveCost > Math.max(0, dailyLimit + this._dailyPnl(validated.closeTs)) + 1e-9) return null;
    const round = { strike: validated.close, openTs: validated.closeTs + 1, closeTs: validated.closeTs + interval };
    try {
      const bet = await this.broker.marketBuy({
        side: signal.signal, sizeUsd,
        clientOrderId: `${this.run.id}:${validated.openTs}:${signal.signal}:${this.risk.step}`,
        round, price: ASSUMED_PRICE, quoteSource: "assumed_0.50",
        feeRate: FEE_SCHEDULE.rate, feeExponent: FEE_SCHEDULE.exponent,
      });
      bet.placedAt = validated.closeTs;
      bet.openedAtIso = new Date(validated.closeTs).toISOString();
      this.broker.openBet.placedAt = validated.closeTs;
      this.broker.openBet.openedAtIso = bet.openedAtIso;
    } catch (error) {
      if (error.code !== "insufficient_balance") throw error;
    }
    this.onChange(this.run);
    return signal;
  }
}

class ResearchRunner {
  constructor({ root, setupStore, engine, onEvent = () => {}, marketFactory = (opts) => new MarketData(opts), now = () => Date.now() }) {
    this.store = new ResearchStore(root);
    this.setupStore = setupStore;
    this.engine = engine;
    this.onEvent = onEvent;
    this.marketFactory = marketFactory;
    this.now = now;
    this.contextActive = false;
    this.streams = new Map();
    this.backtestBusy = false;
    this.runners = new Map();
    for (const run of this.store.value.runs) {
      run.running = false;
      if (run.mode === "paper") run.status = "stopped";
      if (run.mode === "paper") this.runners.set(run.id, new ReplayBook({ setup: run.setup, startingBalance: run.startingBalance, run }));
    }
    this.durableState = structuredClone(this.store.value);
    this.queue = Promise.resolve();
    this.disposed = false;
    for (const method of ["runBacktest", "startPaperRuns", "stopPaperRun", "setResearchContext"]) {
      const call = this[method].bind(this);
      this[method] = (input) => {
        if (method === "setResearchContext" && input?.active === false) this.contextActive = false;
        return this._serial(() => call(input));
      };
    }
  }

  _serial(work) {
    const result = this.queue.catch(() => {}).then(() => {
      if (this.disposed) throw fail("research_disposed");
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  _persist() {
    try {
      this.store.save(this.store.value);
      for (const [id, replay] of this.runners) {
        const current = this.store.value.runs.find((run) => run.id === id);
        if (current) replay.run = current;
      }
      this.durableState = structuredClone(this.store.value);
    } catch (error) {
      this.store.value = structuredClone(this.durableState);
      this.runners = new Map(this.store.value.runs.filter((run) => run.mode === "paper")
        .map((run) => [run.id, new ReplayBook({ setup: run.setup, startingBalance: run.startingBalance, run })]));
      throw error;
    }
  }
  _getVersion(id, version) {
    if (typeof id !== "string" || !Number.isInteger(version) || version < 1) throw fail("invalid_setup_reference");
    const row = this.setupStore.getVersion(id, version);
    if (!row) throw fail("setup_not_found");
    return setupCapture(row);
  }

  async _historicalBars(setup, provided) {
    if (provided != null) return validateBars(provided, setup.settings.timeframe, { now: this.now() });
    const market = this.engine?.market;
    if (market && market.symbol === setup.settings.symbol && market.timeframe === setup.settings.timeframe && market.bars?.length) {
      return validateBars(market.bars, setup.settings.timeframe, { now: this.now() });
    }
    const client = this.marketFactory({ symbol: setup.settings.symbol, timeframe: setup.settings.timeframe });
    try {
      const bars = await client.loadHistory(MAX_DATA_BARS, { emitHistory: false });
      return validateBars(bars, setup.settings.timeframe, { now: this.now() });
    } finally { client.stop?.(); }
  }

  async runBacktest(input = {}) {
    if (this.backtestBusy) throw fail("research_busy");
    this.backtestBusy = true;
    try {
      const setup = this._getVersion(input.id, input.version);
      const startingBalance = validateBalance(input.startingBalance);
      let bars = await this._historicalBars(setup, input.bars);
      const sampleSize = input.sampleSize == null ? MAX_DATA_BARS : Number(input.sampleSize);
      if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > MAX_DATA_BARS) throw fail("invalid_research_sample");
      bars = bars.slice(-sampleSize);
      if (!bars.length) throw fail("research_no_data");
      const interval = INTERVAL_MS[setup.settings.timeframe];
      const fromTs = input.fromTs == null ? null : Number(input.fromTs);
      const toTs = input.toTs == null ? null : Number(input.toTs);
      if ((fromTs != null && (!Number.isFinite(fromTs) || fromTs < 0)) || (toTs != null && (!Number.isFinite(toTs) || toTs < 0)) ||
          (fromTs != null && !Number.isSafeInteger(fromTs)) || (toTs != null && !Number.isSafeInteger(toTs)) ||
          (fromTs != null && fromTs % interval !== 0) || (toTs != null && toTs % interval !== 0) ||
          (fromTs != null && toTs != null && fromTs > toTs)) throw fail("invalid_research_period");
      if (fromTs != null && toTs != null && toTs - fromTs > 20 * 365.25 * 86400_000) throw fail("invalid_research_period");
      const allBars = bars;
      const hashBars = allBars;
      const run = {
        id: crypto.randomUUID(), mode: "backtest", status: "complete", setup,
        startingBalance, createdAt: new Date(this.now()).toISOString(),
        fromTs, toTs, bars: allBars, trades: [], approximate: true,
        datasetHash: datasetHash(hashBars), report: null,
        tickSize: this.engine?.symbols?.find((row) => row.id === setup.settings.symbol)?.tickSize || fallbackTick(setup.settings.symbol),
      };
      const engineBars = allBars.filter((bar) => (toTs == null || bar.closeTs <= toTs));
      const replay = new ReplayBook({ setup, startingBalance, run });
      replay.bars = [];
      for (let i = 0; i < engineBars.length; i += 1) {
        const inRange = fromTs == null || engineBars[i].openTs >= fromTs;
        await replay.advance(engineBars[i], { canEnter: inRange });
      }
      const reportBars = engineBars.filter((bar) => (fromTs == null || bar.openTs >= fromTs) && (toTs == null || bar.closeTs <= toTs));
      run.period = { fromTs: reportBars[0]?.openTs ?? null, toTs: reportBars.at(-1)?.closeTs ?? null, bars: reportBars.length };
      run.stats = makeStats(run);
      run.paperState = replay.state();
      run.bars = allBars;
      run.running = false;
      if (this.store.value.runs.length >= MAX_RUNS) throw fail("research_run_limit");
      this.store.value.runs.push(run);
      this._persist();
      this.onEvent({ type: "research_report", payload: { id: run.id, mode: run.mode, stats: run.stats } });
      return { ok: true, run: this.snapshotRun(run) };
    } finally { this.backtestBusy = false; }
  }

  _streamKey(setup) { return `${setup.settings.symbol}:${setup.settings.timeframe}`; }
  _bindStream(stream) {
    stream.unsubscribe?.();
    stream.unsubscribe = stream.market.on((event, payload) => {
      if (event === "bar_close") {
        stream.queue = stream.queue.then(() => this._serial(() => this._onStreamBar(stream, payload)))
          .catch((error) => this._streamError(stream, error));
      }
    });
  }

  async _acquireStream(setup, run) {
    const key = this._streamKey(setup);
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= STREAM_LIMIT) throw fail("research_stream_limit");
      const market = this.marketFactory({ symbol: setup.settings.symbol, timeframe: setup.settings.timeframe });
      stream = { key, market, owned: true, runs: new Set(), unsubscribe: null, starting: null, queue: Promise.resolve() };
      this._bindStream(stream);
      this.streams.set(key, stream);
    }
    stream.runs.add(run.id);
    const market = stream.market;
    const period = setup.settings.slowPeriod;
    if ((market.bars?.length || 0) < period) await market.loadHistory?.(MAX_DATA_BARS, { emitHistory: false });
    const seed = validateBars(market.bars || [], setup.settings.timeframe, { now: this.now() }).slice(-MAX_DATA_BARS);
    const replay = this.runners.get(run.id);
    if (!replay.bars.length) replay.bars = seed;
    else {
      const latest = replay.bars.at(-1)?.openTs || 0;
      for (const bar of seed) {
        if (bar.openTs <= latest) continue;
        await replay.advance(bar, { canEnter: false });
      }
    }
    const current = this.store.value.runs.find((row) => row.id === run.id);
    current.bars = replay.bars;
    current.paperState = replay.state();
    if (stream.owned && this.contextActive && !stream.starting) {
      stream.starting = Promise.resolve(market.start()).finally(() => { stream.starting = null; });
    }
  }

  async _onStreamBar(stream, bar) {
    if (stream.market.symbol !== stream.key.split(":")[0] || stream.market.timeframe !== stream.key.split(":")[1]) {
      stream.unsubscribe?.();
      stream.market = this.marketFactory({ symbol: stream.key.split(":")[0], timeframe: stream.key.split(":")[1] });
      stream.owned = true;
      this._bindStream(stream);
      const history = await stream.market.loadHistory?.(MAX_DATA_BARS, { emitHistory: false });
      const bars = validateBars(history || stream.market.bars || [], stream.market.timeframe, { now: this.now() });
      for (const id of stream.runs) {
        const run = this.store.value.runs.find((item) => item.id === id);
        const replay = this.runners.get(id);
        if (!run || !replay || !bars.length) continue;
        const latest = replay.bars.at(-1)?.openTs || 0;
        for (const historical of bars) if (historical.openTs > latest) await replay.advance(historical, { canEnter: false });
        run.bars = replay.bars;
        run.paperState = replay.state();
      }
      await stream.market.start?.();
      return;
    }
    const ids = [...stream.runs];
    for (const id of ids) {
      const run = this.store.value.runs.find((row) => row.id === id);
      const replay = this.runners.get(id);
      if (!run || !replay || (!run.running && !run.paperState?.openBet)) continue;
      try {
        await replay.advance(bar, { canEnter: Boolean(run.running && this.contextActive) });
        run.bars = replay.bars;
        run.paperState = replay.state();
        run.stats = makeStats(run);
        this._persist();
        this.onEvent({ type: "research_update", payload: this.snapshotRun(run) });
      } catch (error) { this._streamError(stream, error, run); }
      if (!run.running && !run.paperState?.openBet) {
        stream.runs.delete(id);
        await this._releaseStreamIfIdle(stream);
      }
    }
  }

  _streamError(stream, error, run) {
    const affected = run ? [run] : [...stream.runs].map((id) => this.store.value.runs.find((row) => row.id === id)).filter(Boolean);
    for (const item of affected) {
      if (item.running) { item.running = false; item.status = "error"; item.error = error.code || "research_stream_error"; }
      if (!item.paperState?.openBet) stream.runs.delete(item.id);
    }
    try { this._persist(); } catch { /* keep failed persistence fail-closed */ }
    for (const item of affected) this.onEvent({ type: "research_error", payload: { error: error.code || "research_stream_error", runId: item.id } });
    this._releaseStreamIfIdle(stream).catch(() => {});
  }

  async _releaseStreamIfIdle(stream) {
    if ([...stream.runs].some((id) => {
      const run = this.store.value.runs.find((item) => item.id === id);
      return run?.running || run?.paperState?.openBet;
    })) return;
    stream.unsubscribe?.();
    if (stream.owned) stream.market.stop?.();
    this.streams.delete(stream.key);
  }

  async startPaperRuns({ setups, startingBalance = "1000.00" } = {}) {
    if (!this.contextActive) throw fail("research_owner_inactive");
    if (!Array.isArray(setups) || setups.length < 1 || setups.length > STREAM_LIMIT) throw fail("invalid_research_setups");
    const balance = validateBalance(startingBalance);
    const captured = setups.map((item) => this._getVersion(item?.id, item?.version));
    const keys = new Set(captured.map((setup) => this._streamKey(setup)));
    const active = this.store.value.runs.filter((run) => run.mode === "paper" && (run.running || run.paperState?.openBet));
    const totalActive = active.length + captured.length;
    if (totalActive > STREAM_LIMIT) throw fail("research_run_limit");
    if (new Set(captured.map((setup) => `${setup.id}:${setup.version}`)).size !== captured.length) throw fail("duplicate_research_setup");
    if (this.store.value.runs.length + captured.length > MAX_RUNS) throw fail("research_run_limit");
    if (this.streams.size + [...keys].filter((key) => !this.streams.has(key)).length > STREAM_LIMIT) throw fail("research_stream_limit");
    const created = [];
    for (const setup of captured) {
      const run = {
        id: crypto.randomUUID(), mode: "paper", status: "running", running: true,
        setup, startingBalance: balance, createdAt: new Date(this.now()).toISOString(),
        bars: [], trades: [], approximate: true, period: null, stats: null,
        paperState: null, datasetHash: null,
        tickSize: this.engine?.symbols?.find((row) => row.id === setup.settings.symbol)?.tickSize || fallbackTick(setup.settings.symbol),
      };
      this.store.value.runs.push(run);
      this.runners.set(run.id, new ReplayBook({ setup, startingBalance: balance, run, onChange: () => {} }));
      created.push(run);
    }
    this._persist();
    try {
      for (const run of created) await this._acquireStream(run.setup, run);
      this._persist();
    } catch (error) {
      for (const original of created) {
        const run = this.store.value.runs.find((row) => row.id === original.id);
        run.running = false; run.status = "error"; run.error = error.code || "research_start_failed";
      }
      for (const stream of this.streams.values()) await this._releaseStreamIfIdle(stream);
      this._persist();
      throw error;
    }
    return { ok: true, runs: created.map((run) => this.snapshotRun(this.store.value.runs.find((row) => row.id === run.id))), streams: this.streams.size };
  }

  async stopPaperRun({ id } = {}) {
    const run = this.store.value.runs.find((row) => row.id === id && row.mode === "paper");
    if (!run) throw fail("research_run_not_found");
    run.running = false;
    run.status = "stopped";
    run.paperState = this.runners.get(run.id)?.state() || run.paperState;
    this._persist();
    const stream = this.streams.get(this._streamKey(run.setup));
    if (stream && !run.paperState?.openBet) { stream.runs.delete(run.id); await this._releaseStreamIfIdle(stream); }
    return { ok: true, run: this.snapshotRun(run) };
  }

  async setResearchContext({ active = false } = {}) {
    this.contextActive = Boolean(active);
    if (this.contextActive) {
      for (const run of this.store.value.runs) {
        if (run.mode === "paper" && run.paperState?.openBet && ![...this.streams.values()].some((stream) => stream.runs.has(run.id))) {
          await this._acquireStream(run.setup, run);
        }
      }
      for (const stream of this.streams.values()) {
        if (stream.owned && [...stream.runs].some((id) => {
          const run = this.store.value.runs.find((item) => item.id === id);
          return run?.running || run?.paperState?.openBet;
        })) {
          await stream.market.start?.();
        }
      }
      return true;
    }
    for (const run of this.store.value.runs) {
      if (run.mode === "paper" && run.running) { run.running = false; run.status = "stopped"; }
    }
    for (const stream of [...this.streams.values()]) {
      for (const id of [...stream.runs]) {
        const run = this.store.value.runs.find((item) => item.id === id);
        if (!run?.paperState?.openBet) stream.runs.delete(id);
      }
      await this._releaseStreamIfIdle(stream);
    }
    this._persist();
    return true;
  }

  idle() {
    return !this.store.value.runs.some((run) => run.mode === "paper" && (run.running || run.paperState?.openBet));
  }

  snapshotRun(run) {
    const balance = run.paperState?.balance || run.startingBalance;
    return {
      id: run.id, setup: structuredClone(run.setup), name: run.setup.name,
      mode: run.mode, status: run.status, running: Boolean(run.running), balance,
      startingBalance: run.startingBalance,
      openBet: run.paperState?.openBet ? structuredClone(run.paperState.openBet) : null,
      stats: run.stats || makeStats(run), trades: structuredClone(run.trades),
      datasetHash: run.datasetHash || null, approximate: true, period: run.period || null,
      error: run.error || null,
    };
  }

  researchStatus() {
    return {
      ok: true,
      runs: this.store.value.runs.map((run) => this.snapshotRun(run)),
      reportPeriod: "day",
      streams: [...this.streams.values()].map((stream) => ({ key: stream.key, symbol: stream.market.symbol, timeframe: stream.market.timeframe, runs: stream.runs.size, shared: !stream.owned })),
      active: this.contextActive,
    };
  }

  researchReport({ period = "day", id } = {}) {
    if (!["day", "week", "month"].includes(period)) throw fail("invalid_research_period");
    const now = this.now();
    const date = new Date(now);
    let since;
    if (period === "day") since = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    else if (period === "week") {
      const weekday = (date.getUTCDay() + 6) % 7;
      since = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday);
    } else since = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const runs = this.store.value.runs.filter((run) => !id || run.id === id).map((run) => {
      const trades = run.trades.filter((trade) => Number(trade.ts) >= since && Number(trade.ts) <= now);
      return { id: run.id, name: run.setup.name, mode: run.mode, period, fromTs: since, toTs: now,
        stats: computeStats(trades.map((trade) => ({ ...trade, type: "settled", book: "paper", settlementStatus: "final" })), { book: "paper", maxSteps: run.setup.settings.maxSteps }),
        approximate: true };
    });
    return { ok: true, period, runs };
  }

  exportResearch({ id, period = "month" } = {}) {
    const report = this.researchReport({ id, period });
    const selected = new Set(report.runs.map((run) => run.id));
    const runs = this.store.value.runs.filter((run) => selected.has(run.id));
    const rows = [];
    const columns = ["run_id", "mode", "setup_id", "setup_version", "setup_fingerprint", "time_utc", "side", "stake_usd", "entry_price", "fee_usd", "strike", "settle_close", "outcome", "result", "pnl_usd", "balance_after", "approximate"];
    const cell = (value) => { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const since = report.runs[0]?.fromTs ?? 0;
    for (const run of runs) for (const trade of run.trades) {
      if (Number(trade.ts) < since) continue;
      rows.push([run.id, run.mode, run.setup.id, run.setup.version, run.setup.fingerprint, new Date(trade.ts).toISOString(), trade.side,
        trade.sizeUsd, trade.entryPrice, trade.feeUsd, trade.strike, trade.settleClose, trade.outcome, trade.status, trade.pnl, trade.balanceAfter, true].map(cell).join(","));
    }
    return { ok: true, csv: `\ufeff${[columns.join(","), ...rows].join("\r\n")}\r\n`, count: rows.length };
  }

  dispose() {
    this.disposed = true;
    for (const stream of this.streams.values()) {
      stream.unsubscribe?.();
      if (stream.owned) stream.market.stop?.();
    }
    this.streams.clear();
  }
}

module.exports = { ResearchRunner, ReplayBook, validateBars, datasetHash, setupCapture, makeStats, FEE_SCHEDULE, STREAM_LIMIT };
