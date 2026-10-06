"use strict";

const { getStrategy, listStrategies, DEFAULT_STRATEGY_ID } = require("./strategies/catalog");
const { Risk } = require("./risk");
const { MarketData } = require("./marketData");
const { INTERVAL_MS, SYMBOLS, TIMEFRAMES, HISTORY_BARS, clampRefreshMs, symbolLabel, fallbackTick, fetchExchangeSymbols } = require("./markets");
const { createVenue } = require("./brokers");
const { Journal } = require("./journal");
const { SIZING_MODES, perDollar } = require("./risk");
const { computeStats, todayPnl, dailyBreakdown } = require("./stats");
const { Decimal } = require("./money");
const { outcomeOf } = require("./paperBroker");
const { SUPPORTED_TF, isSupportedSymbol, fitToPolymarket } = require("./brokers/polymarketMarkets");
const { fastPeriodOf, slowPeriodOf, confirmCountOf, fullBodyOnSOf, maTypeOf } = require("./strategy");
const { normalizeSettings, RISK_FIELDS } = require("../shared/settings");
const { DEFAULTS } = require("./settingsStore");

const STATUSES = [
  "stopped",
  "warming_up",
  "watching",
  "order_sent",
  "waiting_settlement",
  "halt",
  "paused",
  "daily_limit",
];

// Auto watchdog: CLOB /time every minute; this many failures in a row pause Auto.
const HEALTH_INTERVAL_MS = 60_000;
const VENUE_FAILURE_LIMIT = 3;
// Consecutive order rejections from the CLOB before Auto pauses.
const REJECT_LIMIT = 2;

/** Highest ask to enter at; 1 means no filter. */
function maxEntryPriceOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 1;
  return Math.max(0.05, Math.round(n * 100) / 100);
}

class Engine {
  constructor({ userDataDir, settings, market, live } = {}) {
    this.userDataDir = userDataDir;
    this.settings = normalizeSettings({ ...DEFAULTS, ...(settings || {}) }, {}, { strict: false });
    this.running = false;
    this.status = "stopped";
    this.mode = this.settings.mode || "paper";
    if (this.mode === "auto") {
      // Auto only trades pairs/timeframes that have a Polymarket round.
      Object.assign(this.settings, fitToPolymarket(this.settings.symbol || "BTCUSDT", this.settings.timeframe || "15m"));
    }
    this.listeners = new Set();
    this.journal = new Journal(`${userDataDir}/journal.jsonl`);
    this.risk = new Risk({
      baseUsd: this.settings.baseUsd || "1.00",
      maxSteps: this.settings.maxSteps || 6,
      sizingMode: this.settings.sizingMode,
      maxStakeUsd: this.settings.maxStakeUsd,
      fixedStakes: this.settings.fixedStakes,
      maxSeriesLossUsd: this.settings.maxSeriesLossUsd,
    });
    const restored = this.journal.restoreRisk(this.risk.maxSteps);
    this.risk.step = restored.step;
    this.risk.consecutiveLosses = restored.consecutiveLosses;
    this.risk.seriesLossUsd = restored.seriesLossUsd || 0;
    this.risk.halted = restored.halted;
    if (restored.halted) this.risk.lotConfirmed = false;
    this.paper = createVenue("paper", { startingBalance: this.settings.paperBalance || "1000.00" });
    this._restorePaper();
    this.lastTestOrder = this.journal.restoreEntries.filter((e) => e.type === "test_order").at(-1) || null;
    this.live =
      live ||
      createVenue("auto", {
        apiKey: this.settings.apiKey || "",
        apiSecret: this.settings.apiSecret || "",
        apiPassphrase: this.settings.apiPassphrase || "",
        walletAddress: this.settings.walletAddress || "",
        privateKey: this.settings.privateKey || "",
        walletType: this.settings.walletType || "AUTO",
        symbol: this.settings.symbol || "BTCUSDT",
        timeframe: this.settings.timeframe || "15m",
        clobUrl: this.settings.clobUrl || "https://clob.polymarket.com",
        gammaUrl: this.settings.gammaUrl || "https://gamma-api.polymarket.com",
      });
    this.market =
      market ||
      new MarketData({
        symbol: this.settings.symbol || "BTCUSDT",
        timeframe: this.settings.timeframe || "15m",
        refreshMs: this.settings.refreshMs || 100,
      });
    this.markers = [];
    this.lastEval = null;
    this.pingResult = null;
    this.liveBet = this.liveBet || null;
    this.lastQuote = null;
    this.liveBalance = {
      ok: true,
      value: this.paper.balance.toFixed(2),
      source: "paper",
      pulsing: false,
    };
    this.lastHandledOpenTs = null;
    this.pauseReason = null;
    this.venueFailures = 0;
    this.orderRejects = 0;
    this._healthTimer = null;
    this._healthBusy = false;
    this._opening = false;
    this._executionGeneration = 0;
    this._barQueue = Promise.resolve();
    this.lastConnect = null;
    this.notificationsEnabled = this.settings.notificationsEnabled !== false;
    this.strategyId = this.settings.strategyId || DEFAULT_STRATEGY_ID;
    this.symbols = SYMBOLS.map((s) => ({ ...s, tickSize: fallbackTick(s.id) }));
    this.tickSize = fallbackTick(this.settings.symbol || "BTCUSDT");
    this._bindMarket();
  }

  strategy() {
    return getStrategy(this.strategyId);
  }

  setStrategy(id) {
    const next = getStrategy(id);
    if (!next || next.enabled === false) {
      this.emit("log", { level: "warn", message: "strategy_unknown" });
      return { ok: false, reason: "unknown" };
    }
    if (next.id === this.strategyId) {
      return { ok: true, strategyId: this.strategyId };
    }
    if (this.paper.openBet) {
      this.emit("log", { level: "warn", message: "strategy_blocked_open_bet" });
      return { ok: false, reason: "open_bet" };
    }
    this.strategyId = next.id;
    this.settings.strategyId = next.id;
    this.markers = [];
    this.lastEval = null;
    this._replayMarkers(true);
    this.journal.write({ type: "strategy", strategyId: next.id });
    this.emit("strategy", { strategyId: next.id });
    return { ok: true, strategyId: next.id };
  }

  broker() {
    return this.mode === "auto" ? this.live : this.paper;
  }

  /** The bet currently in flight, whichever venue placed it. */
  openBet() {
    return this.mode === "auto" ? this.liveBet : this.paper.openBet;
  }

  _testPositionActive() {
    return this.lastTestOrder && !this.lastTestOrder.dryRun && Date.now() <= this.lastTestOrder.roundCloseTs;
  }

  /**
   * One minimum-size order on the current round, placed now, to prove the
   * whole live path (proxy, region, keys, balance, fill) without waiting for
   * a signal. It never touches the series, stats or open-bet state; the
   * position resolves on Polymarket like any other. The first call only
   * prices the order; `confirm: true` places it.
   */
  async testOrder({ side = "UP", confirm = false } = {}) {
    if (this._opening || this.journal.pendingOrder()) return { ok: false, reason: "order_pending" };
    if (this._testPositionActive()) return { ok: false, reason: "test_open_bet" };
    if (confirm) this._executionGeneration += 1;
    this._opening = true;
    try {
      return await this._testOrder({ side, confirm });
    } finally {
      this._opening = false;
    }
  }

  async _testOrder({ side = "UP", confirm = false } = {}) {
    const generation = this._executionGeneration;
    const wanted = side === "DOWN" ? "DOWN" : "UP";
    if (this.mode !== "auto") return { ok: false, reason: "test_auto_only" };
    if (this.openBet()) return { ok: false, reason: "test_open_bet" };
    if (typeof this.live.getQuote !== "function" || typeof this.live.marketBuy !== "function") {
      return { ok: false, reason: "auto_not_wired" };
    }
    const quote = await this.live.getQuote({ side: wanted, tsMs: Date.now() });
    if (!quote || !quote.ok) return { ok: false, reason: (quote && quote.reason) || "no_quote" };
    const tick = Number(quote.tickSize) > 0 ? Number(quote.tickSize) : 0.01;
    const slip = Number.isFinite(Number(this.live.slippage)) ? Number(this.live.slippage) : 0.02;
    // the venue checks the 5-share minimum at the signed ceiling, so size at the ceiling plus a cent
    const ceiling = Math.min(1 - tick, Number(quote.price) + slip);
    const minShares = Number(quote.minOrderSize) > 0 ? Number(quote.minOrderSize) : 5;
    const sizeUsd = (Math.ceil(minShares * ceiling * 100) / 100 + 0.01).toFixed(2);
    if (this.risk.maxStakeUsd > 0 && Number(sizeUsd) > this.risk.maxStakeUsd) {
      return { ok: false, reason: "stake_above_max" };
    }
    const maxTotalCostUsd = this._entryBudget();
    const schedule = { rate: quote.feeRate, exponent: quote.feeExponent };
    const testCost = Math.ceil(Number(sizeUsd) * perDollar(quote.price, schedule).loss * 100 - 1e-9) / 100;
    if (testCost > maxTotalCostUsd + 1e-9) return { ok: false, reason: "budget_exceeded" };
    const dryRun = this.isDryRun();
    const plan = { side: wanted, sizeUsd, price: quote.price, slug: quote.slug, dryRun };
    if (!confirm) return { ok: false, reason: "test_confirm", ...plan };
    if (generation !== this._executionGeneration) return { ok: false, reason: "execution_changed" };
    const clientOrderId = `test-${Date.now()}-${wanted}`;
    const interval = INTERVAL_MS[this.settings.timeframe || "15m"] || 900_000;
    const roundCloseTs = (Math.floor(Date.now() / interval) + 1) * interval - 1;
    let accepted = false;
    try {
      if (!dryRun) this.journal.beginOrder({ clientOrderId, side: wanted, sizeUsd, test: true });
      const order = await this.live.marketBuy({
        side: wanted,
        sizeUsd,
        clientOrderId,
        round: { openTs: Date.now() },
        dryRun,
        isActive: () => generation === this._executionGeneration,
        maxTotalCostUsd,
      });
      accepted = true;
      const row = {
        clientOrderId,
        roundCloseTs,
        side: wanted,
        dryRun,
        sizeUsd: order.sizeUsd,
        price: order.price,
        shares: order.shares,
        orderId: order.orderId || null,
        orderStatus: order.orderStatus || null,
        slug: order.slug || quote.slug,
      };
      this.journal.write({ type: "test_order", ...row });
      this.lastTestOrder = row;
      this.journal.completeOrder(clientOrderId);
      this.emit("log", { level: "info", message: `test_order: ${wanted} $${order.sizeUsd} @ ${order.price}${dryRun ? " (dry run, not sent)" : ` · ${order.orderStatus || "sent"}`}` });
      return { ok: true, ...row };
    } catch (err) {
      if (!err.ambiguous && !accepted) this.journal.completeOrder(clientOrderId);
      else this._pauseUnknownOrder();
      const message = String((err && err.message) || err);
      this.journal.write({ type: "test_order_error", side: wanted, code: (err && err.code) || null, message });
      this.emit("log", { level: "error", message: `test_order_error: ${message}` });
      return { ok: false, reason: (err && err.code) || "order_error", message, ...plan };
    }
  }

  /**
   * Live Polymarket quote for a side. Returns null when the venue cannot
   * price the round (no network, unsupported timeframe, round already closed).
   */
  async _quoteFor(side, round) {
    if (typeof this.live.getQuote !== "function") return null;
    try {
      const quote = await this.live.getQuote({
        side,
        tsMs: round && round.openTs ? round.openTs : Date.now(),
      });
      if (!quote || !quote.ok) {
        this.emit("log", { level: "warn", message: `quote_unavailable: ${(quote && quote.reason) || "unknown"}` });
        return null;
      }
      const { asks, ...light } = quote;
      this.lastQuote = light;
      return quote;
    } catch (err) {
      this.emit("log", { level: "warn", message: `quote_error: ${String(err.message || err)}` });
      return null;
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    const light = type === "tick";
    const msg = { type, payload };
    if (!light) msg.state = this.snapshot();
    for (const fn of this.listeners) fn(msg);
  }

  _bindMarket() {
    this.market.on((event, payload) => {
      if (event === "history") {
        this._replayMarkers(this.markers.length === 0);
        this.emit("history", payload);
      }
      if (event === "bar_close") {
        this.onBarClose(payload).catch((err) => {
          this.pause(`processing_error: ${String(err.message || err)}`);
        });
        this.emit("bar", payload);
      }
      if (event === "tick") {
        this.emit("tick", payload);
      }
      if (event === "health") {
        this.dataHealth = payload;
        this.journal.write({ type: "data_health", ...payload });
        this.emit("log", { level: "info", message: `market_data: ${payload.state}${payload.reason ? ` (${payload.reason})` : ""}` });
      }
      if (event === "error") {
        this.journal.write({ type: "data_error", message: payload });
        this.emit("log", { level: "error", message: payload });
      }
    });
  }

  /**
   * Rebuild the paper balance / open bet and any unsettled live bet from the
   * journal, so a restart mid-round settles with the same stake, shares and fee.
   */
  _restorePaper() {
    const entries = this.journal.restoreEntries;
    const isLive = (e) => e.mode === "auto";
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (e.type === "paper_reset") {
        if (e.balance) this.paper.balance = Decimal(e.balance);
        break;
      }
      if (e.type === "settled" && !isLive(e)) {
        if (e.balanceAfter) this.paper.balance = Decimal(e.balanceAfter);
        break;
      }
      if (e.type === "order_sent" && !isLive(e) && e.side && e.sizeUsd) {
        if (e.balanceAfter) this.paper.balance = Decimal(e.balanceAfter);
        this.paper.openBet = {
          clientOrderId: e.clientOrderId,
          side: e.side,
          sizeUsd: e.sizeUsd,
          feeUsd: e.feeUsd || "0",
          payout: e.payout,
          shares: e.shares,
          entryPrice: e.entryPrice,
          strike: e.strike,
          roundOpenTs: e.roundOpenTs,
          roundCloseTs: e.roundCloseTs,
          placedAt: e.placedAt || Date.now(),
          status: "open",
        };
        break;
      }
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (!isLive(e)) continue;
      if (e.type === "settled") break;
      if (e.type === "order_sent" && e.side && e.sizeUsd) {
        this.liveBet = {
          dryRun: Boolean(e.dryRun),
          clientOrderId: e.clientOrderId,
          side: e.side,
          sizeUsd: e.sizeUsd,
          payout: e.payout,
          entryPrice: e.price,
          shares: e.shares,
          feeUsd: e.feeUsd,
          orderId: e.orderId,
          slug: e.slug,
          strike: e.strike,
          roundOpenTs: e.roundOpenTs,
          roundCloseTs: e.roundCloseTs,
          placedAt: e.placedAt || Date.now(),
          status: "open",
        };
        break;
      }
    }
  }

  _replayMarkers(force = false) {
    if (this.markers.length && !force) return;
    this.markers = [];
    const bars = this.market.bars;
    const warm = Math.max(0, this._slowPeriod() - 1);
    for (let i = warm; i < bars.length; i += 1) {
      const ev = this.strategy().evaluate(bars, i, this._evalOptions());
      if (ev.signal) {
        const interval = INTERVAL_MS[this.settings.timeframe || "15m"] || 900_000;
        this.markers.push({
          time: Math.floor((bars[i].openTs + interval) / 1000),
          side: ev.signal,
          size: null,
          virtual: true,
        });
      }
    }
  }

  _ensureMarket() {
    if (typeof this.market.start === "function" && !this.market.timer && !this.market.ws) {
      this.market.start();
    } else if (typeof this.market.start === "function" && !this.market._wanted) {
      this.market.start();
    }
  }

  /**
   * Load live markets from the venue and merge into this.symbols.
   * Silently swallows errors — live trading works without this.
   */
  async _loadLiveMarkets() {
    if (typeof this.live.loadMarkets !== "function") return;
    try {
      const markets = await this.live.loadMarkets();
      if (markets && markets.length) {
        this.emit("log", { level: "info", message: `live_markets_loaded: ${markets.length}` });
      }
    } catch (err) {
      this.emit("log", { level: "warn", message: `live_markets_error: ${String(err.message || err)}` });
    }
  }

  async applySettings(input = {}) {
    const patch = normalizeSettings(input, this.settings);
    const changed = Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(this.settings[key]));
    const tradingFields = new Set([...RISK_FIELDS, "maxEntryPrice", "dailyLossLimitUsd", "dryRun", "symbol", "timeframe", "maType", "fastPeriod", "slowPeriod", "minOpeningAtr", "minCrossTicks", "confirmCount", "fullBodyOnS", "strategyId", "privateKey", "walletAddress", "walletType", "proxyUrl", "apiKey", "apiSecret", "apiPassphrase"]);
    const positionActive = this._opening || this.openBet() || this.liveBet || this.paper.openBet || this._testPositionActive() || this.journal.pendingOrder();
    const lockedField = changed.find((key) =>
      (positionActive && tradingFields.has(key)) ||
      (this.risk.consecutiveLosses > 0 && RISK_FIELDS.includes(key))
    );
    if (lockedField) {
      const err = new Error("settings_locked: finish the position or explicitly confirm a halted new series first");
      err.code = "settings_locked";
      err.field = lockedField;
      throw err;
    }
    if (changed.some((key) => tradingFields.has(key))) this._executionGeneration += 1;
    if (this.mode === "auto") {
      if (patch.symbol != null && !isSupportedSymbol(patch.symbol)) {
        this.emit("log", { level: "warn", message: `market_unsupported_in_auto: ${patch.symbol}` });
        delete patch.symbol;
      }
      if (patch.timeframe != null && !SUPPORTED_TF.includes(String(patch.timeframe))) {
        this.emit("log", { level: "warn", message: `market_unsupported_in_auto: ${patch.timeframe}` });
        delete patch.timeframe;
      }
    }
    // An open bet settles on its own market's next bar; switching the chart
    // under it would settle a BTC strike against an ETH candle.
    const moves =
      (patch.symbol != null && patch.symbol !== this.settings.symbol) ||
      (patch.timeframe != null && patch.timeframe !== this.settings.timeframe);
    if (moves && (this.paper.openBet || this.liveBet)) {
      this.emit("log", { level: "warn", message: "market_blocked_open_bet" });
      this.journal.write({ type: "market_blocked", reason: "open_bet" });
      delete patch.symbol;
      delete patch.timeframe;
    }
    const next = { ...this.settings, ...patch };
    if (patch.refreshMs != null) {
      next.refreshMs = clampRefreshMs(patch.refreshMs);
      if (typeof this.market.setRefreshMs === "function") {
        this.market.setRefreshMs(next.refreshMs);
      }
    }
    if (patch.minCrossTicks != null) {
      next.minCrossTicks = Math.max(0, Number(patch.minCrossTicks) || 0);
    }
    if (patch.minOpeningAtr != null) {
      next.minOpeningAtr = Number(patch.minOpeningAtr);
    }
    if (patch.confirmCount != null) {
      next.confirmCount = confirmCountOf({ confirmCount: patch.confirmCount });
    }
    if (patch.fullBodyOnS != null) {
      next.fullBodyOnS = fullBodyOnSOf({ fullBodyOnS: patch.fullBodyOnS });
    }
    if (patch.maType != null) {
      next.maType = maTypeOf({ maType: patch.maType });
    }
    if (patch.fastPeriod != null || patch.slowPeriod != null) {
      next.fastPeriod = fastPeriodOf(next);
      next.slowPeriod = slowPeriodOf(next);
    }
    if (patch.maxSteps != null) {
      this.risk.maxSteps = Math.max(1, Number(patch.maxSteps) || 1);
    }
    if (patch.sizingMode != null) {
      next.sizingMode = SIZING_MODES.includes(patch.sizingMode) ? patch.sizingMode : "double";
      this.risk.configure({ sizingMode: next.sizingMode });
    }
    if (patch.maxStakeUsd != null) {
      next.maxStakeUsd = Math.max(0, Number(patch.maxStakeUsd) || 0);
      this.risk.configure({ maxStakeUsd: next.maxStakeUsd });
    }
    if (patch.fixedStakes != null || patch.maxSeriesLossUsd != null) {
      const riskPatch = {};
      if (patch.fixedStakes != null) riskPatch.fixedStakes = patch.fixedStakes;
      if (patch.maxSeriesLossUsd != null) riskPatch.maxSeriesLossUsd = patch.maxSeriesLossUsd;
      this.risk.configure(riskPatch);
    }
    if (patch.maxEntryPrice != null) {
      next.maxEntryPrice = maxEntryPriceOf(patch.maxEntryPrice);
    }
    if (patch.dailyLossLimitUsd != null) {
      next.dailyLossLimitUsd = Math.max(0, Number(patch.dailyLossLimitUsd) || 0);
    }
    if (patch.dryRun != null) {
      const on = patch.dryRun !== false;
      if (on !== this.isDryRun()) {
        if (this.liveBet) {
          this.emit("log", { level: "warn", message: "dry_run_blocked_open_bet" });
          next.dryRun = this.isDryRun();
        } else {
          next.dryRun = on;
          if (this.running && this.mode === "auto") {
            // going live needs the start confirmation
            this.running = false;
            this._stopHealth();
            this.status = "stopped";
          }
          // dry and live keep separate series
          this.risk.reset();
          this.journal.write({ type: "dry_run", on });
        }
      } else {
        next.dryRun = on;
      }
    }
    if (patch.notificationsEnabled != null) {
      next.notificationsEnabled = Boolean(patch.notificationsEnabled);
      this.notificationsEnabled = next.notificationsEnabled;
    }
    if (patch.baseUsd != null) {
      next.baseUsd = Decimal(patch.baseUsd).toFixed(2);
      this.risk.baseUsd = Decimal(next.baseUsd);
    }
    const symbol = next.symbol || this.settings.symbol || "BTCUSDT";
    const timeframe = next.timeframe || this.settings.timeframe || "15m";
    const marketChanged = symbol !== (this.settings.symbol || "BTCUSDT") || timeframe !== (this.settings.timeframe || "15m");
    this.settings = next;
    if (typeof this.live.configure === "function") {
      this.live.configure({
        apiKey: next.apiKey,
        apiSecret: next.apiSecret,
        apiPassphrase: next.apiPassphrase,
        walletAddress: next.walletAddress,
        privateKey: next.privateKey,
        walletType: next.walletType,
        proxyUrl: next.proxyUrl,
        symbol,
        timeframe,
      });
    }
    if (marketChanged && typeof this.market.configure === "function") {
      this.tickSize = this._tickFor(symbol);
      await this.market.configure({
        symbol,
        timeframe,
        refreshMs: next.refreshMs,
      });
      this.tickSize = this._tickFor(symbol);
      this.markers = [];
      this.lastEval = null;
      this.lastHandledOpenTs = null;
      this._replayMarkers(true);
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    } else if (
      patch.minOpeningAtr != null ||
      patch.minCrossTicks != null ||
      patch.confirmCount != null ||
      patch.fullBodyOnS != null ||
      patch.fastPeriod != null ||
      patch.slowPeriod != null ||
      patch.maType != null
    ) {
      this._replayMarkers(true);
    }
    this.emit("settings", this.settings);
    return this.snapshot();
  }

  async warmChart() {
    try {
      if (typeof this.market.loadHistory === "function") {
        await this.market.loadHistory(HISTORY_BARS);
      }
      this._ensureMarket();
      if (typeof this.market.fetchJson === "function") {
        try {
          this.symbols = await fetchExchangeSymbols(this.market.fetchJson);
        } catch {
          this.symbols = SYMBOLS.map((s) => ({ ...s, tickSize: fallbackTick(s.id) }));
        }
      }
      this.tickSize = this._tickFor(this.settings.symbol);
      this._replayMarkers(true);
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    } catch (err) {
      this.journal.write({ type: "data_error", message: String(err.message || err) });
      this.emit("log", { level: "error", message: String(err.message || err) });
    }
    return this.snapshot();
  }

  /** Auto without dry run spends real money. */
  isLiveMoney() {
    return this.mode === "auto" && !this.isDryRun();
  }

  isDryRun() {
    return this.settings.dryRun !== false;
  }

  _book() {
    if (this.mode !== "auto") return "paper";
    return this.isDryRun() ? "dry" : "live";
  }

  dailyLossLimit() {
    return Math.max(0, Number(this.settings.dailyLossLimitUsd) || 0);
  }

  todayPnl() {
    return todayPnl(this.journal.restoreEntries, this._book());
  }

  _dailyLimitHit() {
    const limit = this.dailyLossLimit();
    return limit > 0 && -this.todayPnl() >= limit - 1e-9;
  }

  /**
   * @param {{ confirmLive?: boolean }} opts real-money Auto must be confirmed
   *   explicitly on every start; the UI shows what is at stake first.
   */
  async start(opts = {}) {
    if (this._starting) return { ok: false, reason: "start_pending" };
    this._starting = true;
    try {
      return await this._start(opts);
    } finally {
      this._starting = false;
    }
  }

  async _start(opts = {}) {
    const generation = this._executionGeneration;
    if (this.mode === "auto" && this._testPositionActive()) return { ok: false, reason: "test_open_bet" };
    if (this.journal.pendingOrder()) {
      this._pauseUnknownOrder();
      return { ok: false, reason: "order_outcome_unknown" };
    }
    if (this.risk.halted || !this.risk.lotConfirmed) {
      this.running = false;
      this.status = "halt";
      this.emit("status", this.status);
      return { ok: false, reason: "halted" };
    }
    if (this.running) return { ok: true };
    if (this._dailyLimitHit()) {
      this.status = "daily_limit";
      this.emit("status", this.status);
      return { ok: false, reason: "daily_limit" };
    }
    if (this.isLiveMoney() && typeof this.live.region === "function") {
      // a broken proxy fails every order the same way; refuse instead of failing on the first signal
      if (typeof this.live.health === "function") {
        const h = await this.live.health();
        if (h && !h.ok && /^proxy_/.test(String(h.code || ""))) {
          this.journal.write({ type: "start_refused", reason: h.code, detail: h.reason || null });
          return { ok: false, reason: h.code, detail: h.reason || null };
        }
      }
      // an unknown answer does not block: the order error still pauses Auto
      const geo = await this.live.region();
      if (geo && geo.ok && geo.blocked) {
        this.journal.write({ type: "start_refused", reason: "geoblocked", country: geo.country || null });
        return { ok: false, reason: "geoblocked", country: geo.country || null };
      }
    }
    if (this.isLiveMoney() && !opts.confirmLive) {
      return { ok: false, reason: "live_confirm_required" };
    }
    if (generation !== this._executionGeneration) return { ok: false, reason: "execution_changed" };
    this.pauseReason = null;
    this.venueFailures = 0;
    this.orderRejects = 0;
    this.running = true;
    this.status = "warming_up";
    this.emit("status", this.status);
    if (typeof this.market.loadHistory === "function" && this.market.bars.length < this._slowPeriod()) {
      try {
        await this.market.loadHistory(HISTORY_BARS);
      } catch (err) {
        this.journal.write({ type: "data_error", message: String(err.message || err) });
        this.emit("log", { level: "error", message: `history_unavailable: ${String(err.message || err)}` });
      }
    }
    if (generation !== this._executionGeneration) return { ok: false, reason: "execution_changed" };
    const last = this.market.bars[this.market.bars.length - 1];
    if (last && this.openBet()) {
      this._settleIfOpen(last);
      if (!this.running) return { ok: false, reason: this.pauseReason || "halted" };
    }
    if (last) this.lastHandledOpenTs = last.openTs;
    this._ensureMarket();
    if (this.market.bars.length < this._slowPeriod()) {
      this.status = "warming_up";
    } else {
      this.status = this.openBet() ? "waiting_settlement" : "watching";
    }
    this.journal.write({ type: "start", mode: this.mode, dryRun: this.mode === "auto" ? this.isDryRun() : undefined });
    this.emit("status", this.status);
    this._startHealth();
    return { ok: true };
  }

  _startHealth() {
    this._stopHealth();
    if (this.mode !== "auto" || typeof this.live.health !== "function") return;
    this._healthTimer = setInterval(() => {
      this._healthTick().catch(() => {});
    }, HEALTH_INTERVAL_MS);
    if (typeof this._healthTimer.unref === "function") this._healthTimer.unref();
  }

  _stopHealth() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = null;
  }

  async _healthTick() {
    const recovering = !this.running && this.pauseReason && this.pauseReason.startsWith("venue_down:");
    if ((!this.running && !recovering) || this._healthBusy || this.mode !== "auto" || typeof this.live.health !== "function") return;
    this._healthBusy = true;
    const generation = this._executionGeneration;
    try {
      const res = await this.live.health();
      if (generation !== this._executionGeneration) return;
      if (res && res.ok) {
        if (recovering) {
          if (this._opening || this._testPositionActive() || this.journal.pendingOrder() || this.risk.halted || this._dailyLimitHit()) return;
          if (this.isLiveMoney() && typeof this.live.region === "function") {
            const region = await this.live.region({ maxAgeMs: 0 });
            if (!region || !region.ok || region.blocked || generation !== this._executionGeneration) return;
          }
          if (this._opening || this._testPositionActive() || this.journal.pendingOrder() || this.risk.halted || this._dailyLimitHit()) return;
          this.running = true;
          this.pauseReason = null;
          this.status = this.openBet() ? "waiting_settlement" : "watching";
          this.journal.write({ type: "auto_resumed", reason: "venue_recovered" });
          this.emit("status", this.status);
        }
        this._venueOk();
      } else this._venueFailed(`health: ${(res && res.reason) || "unreachable"}`);
    } catch (err) {
      if (generation === this._executionGeneration) this._venueFailed(`health: ${String(err.message || err)}`);
    } finally {
      this._healthBusy = false;
    }
  }

  _venueOk() {
    this.venueFailures = 0;
  }

  _venueFailed(reason) {
    this.venueFailures += 1;
    this.journal.write({ type: "venue_failure", reason, count: this.venueFailures });
    this.emit("log", { level: "warn", message: `venue_failure ${this.venueFailures}/${VENUE_FAILURE_LIMIT}: ${reason}` });
    if (this.venueFailures >= VENUE_FAILURE_LIMIT) this.pause(`venue_down: ${reason}`);
  }

  /** Stop Auto and say why. Settlement of an open bet continues; Start resumes. */
  pause(reason) {
    if (!this.running) return;
    this._executionGeneration += 1;
    this.running = false;
    if (!reason.startsWith("venue_down:")) this._stopHealth();
    this.pauseReason = reason;
    this.status = "paused";
    this.journal.write({ type: "auto_paused", reason });
    this.emit("log", { level: "error", message: `auto_paused: ${reason}` });
    this.notify("halt", "Auto paused", reason);
    this.emit("status", this.status);
  }

  _hitDailyLimit() {
    this._executionGeneration += 1;
    this.running = false;
    this._stopHealth();
    this.status = "daily_limit";
    const pnl = this.todayPnl().toFixed(2);
    this.journal.write({ type: "daily_limit", pnl, limit: this.dailyLossLimit() });
    this.notify("halt", "Daily loss limit", `Today $${pnl}, limit $${this.dailyLossLimit()} \u2014 stopped until tomorrow`);
    this.emit("status", this.status);
  }

  stop() {
    this._executionGeneration += 1;
    this._stopHealth();
    this.pauseReason = null;
    this.running = false;
    this.status = this.openBet() ? "waiting_settlement" : "stopped";
    this.journal.write({ type: "stop" });
    this.emit("status", this.status);
  }

  async setMode(mode) {
    if (this._opening || this.journal.pendingOrder()) {
      this.emit("log", { level: "warn", message: "mode_blocked_order_pending" });
      return this.snapshot();
    }
    if (mode === this.mode) {
      if (mode === "auto") {
        await this.refreshLiveBalance();
        await this._loadLiveMarkets();
      }
      return this.snapshot();
    }
    if (this.openBet() || this.liveBet || this.paper.openBet) {
      this.emit("log", { level: "warn", message: "mode_blocked_open_bet" });
      return this.snapshot();
    }
    this.mode = mode;
    this._executionGeneration += 1;
    this.risk.reset();
    if (this.running) {
      // Switching books mid-run would start Auto without its confirmation.
      this.running = false;
      this._stopHealth();
      this.status = "stopped";
    }
    this.journal.write({ type: "mode", mode });
    if (mode === "auto") {
      const fit = fitToPolymarket(this.settings.symbol || "BTCUSDT", this.settings.timeframe || "15m");
      if (fit.symbol !== this.settings.symbol || fit.timeframe !== this.settings.timeframe) {
        this.journal.write({ type: "market_adjusted", from: `${this.settings.symbol} ${this.settings.timeframe}`, to: `${fit.symbol} ${fit.timeframe}` });
        this.emit("log", { level: "warn", message: `market_adjusted: ${fit.symbol} ${fit.timeframe} (no Polymarket round for the previous pick)` });
        await this.applySettings(fit);
      }
    }
    if (mode === "auto") {
      await this.refreshLiveBalance();
      await this._loadLiveMarkets();
    } else {
      this.liveBalance = {
        ok: true,
        value: this.paper.balance.toFixed(2),
        source: "paper",
        pulsing: false,
      };
    }
    this.emit("mode", mode);
    return this.snapshot();
  }

  confirmLot(baseUsd, { resetSeries = false } = {}) {
    if (this._opening || this.openBet() || this.liveBet || this.paper.openBet || this.journal.pendingOrder() || this._testPositionActive()) {
      const err = new Error("settings_locked: a position or order is active");
      err.code = "settings_locked";
      throw err;
    }
    const accepted = normalizeSettings({ baseUsd }, this.settings);
    if (resetSeries && this.running) {
      const err = new Error("settings_locked: Stop before starting a new series");
      err.code = "settings_locked";
      throw err;
    }
    if (!resetSeries && !this.risk.halted && this.risk.consecutiveLosses > 0 && accepted.baseUsd !== this.risk.baseUsd.toFixed(2)) {
      const err = new Error("settings_locked: base cannot change mid-series");
      err.code = "settings_locked";
      throw err;
    }
    baseUsd = accepted.baseUsd;
    const resetRisk = this.risk.halted || resetSeries;
    if (resetSeries) this.risk.reset();
    this.risk.confirmLot(baseUsd);
    this.settings.baseUsd = Decimal(baseUsd).toFixed(2);
    this.journal.write({ type: "lot_confirmed", baseUsd: this.settings.baseUsd, resetRisk });
    if (this.running) {
      this.status = this.paper.openBet ? "waiting_settlement" : "watching";
      this._ensureMarket();
    }
    this.emit("status", this.status);
  }

  resetPaper(startingBalance) {
    if (this.mode !== "paper" || this.paper.openBet || this.liveBet || this._opening || this.journal.pendingOrder()) {
      this.emit("log", { level: "warn", message: "reset_blocked_open_bet" });
      return this.snapshot();
    }
    const start = startingBalance || this.settings.paperBalance || "1000.00";
    this.paper.reset(start);
    this.risk.reset();
    this.risk.lotConfirmed = true;
    this.journal.write({ type: "paper_reset", balance: this.paper.balance.toFixed(2) });
    this.emit("balance", { ok: true, value: this.paper.balance.toFixed(2), source: "paper" });
    return this.snapshot();
  }

  notify(kind, title, body) {
    if (!this.notificationsEnabled) return;
    this.emit("notify", { kind, title, body, at: Date.now() });
  }

  /**
   * One-button setup: store the wallet / key / type, fetch the CLOB keys from
   * the private key when needed, and run every check a live order depends on.
   * Each check is { id, status: ok|warn|fail|skip, ...data }; a failed check
   * skips the ones that depend on it. Secrets are returned only for main.js
   * to persist and never reach the window.
   */
  async connect(patch = {}) {
    const keep = (v) => v != null && String(v).trim() !== "";
    for (const key of ["apiKey", "apiSecret", "apiPassphrase", "privateKey"]) {
      if (keep(patch[key])) this.settings[key] = String(patch[key]).trim();
    }
    if (patch.walletAddress != null) this.settings.walletAddress = String(patch.walletAddress).trim();
    if (patch.walletType != null) this.settings.walletType = patch.walletType;
    if (patch.proxyUrl != null) this.settings.proxyUrl = String(patch.proxyUrl).trim();
    const manualKeys = keep(patch.apiKey) || keep(patch.apiSecret) || keep(patch.apiPassphrase);
    if (typeof this.live.configure === "function") {
      this.live.configure({
        apiKey: this.settings.apiKey,
        apiSecret: this.settings.apiSecret,
        apiPassphrase: this.settings.apiPassphrase,
        walletAddress: this.settings.walletAddress,
        privateKey: this.settings.privateKey,
        walletType: this.settings.walletType,
        proxyUrl: this.settings.proxyUrl,
        symbol: this.settings.symbol,
        timeframe: this.settings.timeframe,
      });
    }

    const checks = [];
    const add = (c) => {
      checks.push(c);
      return c.status === "ok" || c.status === "warn";
    };
    const skip = (id) => checks.push({ id, status: "skip" });
    let credentials = null;

    // 1. network / region
    const health = typeof this.live.health === "function" ? await this.live.health() : { ok: false, reason: "unsupported" };
    const netOk = add(
      health.ok
        ? { id: "network", status: "ok", latencyMs: health.latencyMs }
        : { id: "network", status: "fail", reason: health.reason, code: health.code || null, blocked: /^geoblocked/.test(String(health.reason)) }
    );

    // 1b. region: reads work from a blocked IP, only orders are refused, so ask explicitly
    if (netOk && typeof this.live.region === "function") {
      const geo = await this.live.region({ maxAgeMs: 0 });
      add(
        geo && geo.ok
          ? { id: "region", status: geo.blocked ? "fail" : "ok", country: geo.country || null, ip: geo.ip || null, proxied: Boolean(this.settings.proxyUrl) }
          : { id: "region", status: "warn", reason: (geo && geo.reason) || "unknown" }
      );
    }

    // 2. signing key
    const signer = typeof this.live.signerAddress === "function" ? this.live.signerAddress() : null;
    const keyOk = add(
      signer
        ? { id: "key", status: "ok", address: signer }
        : { id: "key", status: "fail", reason: this.settings.privateKey ? "invalid" : "missing" }
    );

    // 3. wallet address
    const wallet = this.settings.walletAddress || "";
    const walletOk = add(
      /^0x[0-9a-fA-F]{40}$/.test(wallet)
        ? { id: "wallet", status: "ok", address: wallet }
        : { id: "wallet", status: "fail", reason: wallet ? "invalid" : "missing" }
    );

    // 4. wallet type
    if (keyOk && walletOk) {
      const detected = this.live.detectedWalletType();
      const used = this.live.resolvedWalletType();
      add({ id: "walletType", status: used === detected ? "ok" : "warn", used, detected });
    } else skip("walletType");

    // 5. CLOB keys: derive unless the user typed their own
    let l2Ok = false;
    if (netOk && keyOk && walletOk) {
      if (!manualKeys && typeof this.live.deriveCredentials === "function") {
        const res = await this.live.deriveCredentials();
        if (res.ok) {
          this.settings.apiKey = res.apiKey;
          this.settings.apiSecret = res.apiSecret;
          this.settings.apiPassphrase = res.apiPassphrase;
          credentials = { apiKey: res.apiKey, apiSecret: res.apiSecret, apiPassphrase: res.apiPassphrase };
        } else {
          add({ id: "clobKeys", status: "fail", reason: res.reason || "derive_failed" });
        }
      }
      if (!checks.some((c) => c.id === "clobKeys")) {
        const acct = await this.live.account();
        if (acct.ok) {
          l2Ok = add({ id: "clobKeys", status: "ok", source: manualKeys ? "manual" : "derived" });
          this._lastAccount = acct;
        } else {
          add({ id: "clobKeys", status: "fail", reason: acct.reason, httpStatus: acct.status || null });
        }
      }
    } else skip("clobKeys");

    // 6. current round and price
    let quote = null;
    if (netOk) {
      const q = typeof this.live.getQuote === "function" ? await this.live.getQuote({ side: "UP", tsMs: Date.now() }) : null;
      if (q && q.ok) {
        quote = q;
        const { asks, ...light } = q;
        this.lastQuote = light;
        add({ id: "market", status: "ok", slug: q.slug, price: q.price, minOrderSize: q.minOrderSize, feeRate: q.feeRate });
      } else {
        add({ id: "market", status: "fail", reason: (q && q.reason) || "no_quote" });
      }
    } else skip("market");

    // 7. balance against what the series needs
    if (l2Ok) {
      const acct = this._lastAccount;
      const price = quote ? quote.price : 0.5;
      const schedule = quote ? { rate: quote.feeRate, exponent: quote.feeExponent } : undefined;
      const minShares = quote ? Number(quote.minOrderSize) || 5 : 5;
      const minStake = Math.ceil(minShares * price * 100) / 100;
      const firstStake = Math.max(this.risk.baseUsd.toNumber(), minStake);
      const perDollarFee = perDollar(price, schedule).fee;
      const firstNeed = Number((firstStake * (1 + perDollarFee)).toFixed(2));
      const series = this.risk.plan(price, schedule);
      const seriesNeed = series.steps.reduce((sum, s) => sum + s.stake * (1 + perDollarFee), 0);
      const bal = acct.balanceUsd;
      add({
        id: "balance",
        status: bal == null ? "warn" : bal < firstNeed ? "fail" : bal < seriesNeed ? "warn" : "ok",
        balance: bal,
        firstNeed,
        seriesNeed: Number(seriesNeed.toFixed(2)),
        baseBelowMin: this.risk.baseUsd.toNumber() < minStake,
        minStake,
      });
      // 8. exchange allowance
      add({
        id: "allowance",
        status: acct.exchange === "set" ? "ok" : acct.exchange === "zero" ? "fail" : "warn",
        state: acct.exchange || "unknown",
      });
    } else {
      skip("balance");
      skip("allowance");
    }

    const ready = checks.every((c) => c.status === "ok" || c.status === "warn");
    this.lastConnect = { at: Date.now(), ready, checks };
    this.journal.write({
      type: "connect",
      ready,
      checks: checks.map((c) => `${c.id}:${c.status}`).join(" "),
    });
    if (this.mode === "auto") await this.refreshLiveBalance();
    this.emit("connect", this.lastConnect);
    return { ...this.lastConnect, credentials };
  }

  async pingApi(creds = {}) {
    const patch = typeof creds === "string" ? { apiKey: creds } : creds || {};
    const keep = (value) => value != null && String(value) !== "";
    if (keep(patch.apiKey)) this.settings.apiKey = patch.apiKey;
    if (keep(patch.apiSecret)) this.settings.apiSecret = patch.apiSecret;
    if (keep(patch.apiPassphrase)) this.settings.apiPassphrase = patch.apiPassphrase;
    if (patch.walletAddress != null) this.settings.walletAddress = patch.walletAddress;
    if (patch.proxyUrl != null) this.settings.proxyUrl = patch.proxyUrl;
    if (patch.walletType != null) this.settings.walletType = patch.walletType;
    if (keep(patch.privateKey)) this.settings.privateKey = patch.privateKey;
    if (typeof this.live.configure === "function") {
      this.live.configure({
        apiKey: this.settings.apiKey,
        apiSecret: this.settings.apiSecret,
        apiPassphrase: this.settings.apiPassphrase,
        walletAddress: this.settings.walletAddress,
        privateKey: this.settings.privateKey,
        walletType: this.settings.walletType,
        proxyUrl: this.settings.proxyUrl,
        symbol: this.settings.symbol,
        timeframe: this.settings.timeframe,
      });
    } else if (keep(patch.apiKey)) {
      this.live.apiKey = patch.apiKey;
    }
    const paper = await this.paper.ping();
    const live = await this.live.ping();
    this.pingResult = { paper, live, at: Date.now() };
    this.journal.write({ type: "api_ping", paper, live: { ...live, apiKey: undefined } });
    if (this.mode === "auto") {
      await this.refreshLiveBalance();
      await this._loadLiveMarkets();
    }
    this.emit("ping", this.pingResult);
    return this.pingResult;
  }

  /**
   * Pull the L2 credentials from the CLOB using the stored signing key.
   * Polymarket has no UI for these, so the app derives them itself.
   */
  async deriveApiKeys(patch = {}) {
    if (patch.privateKey != null && String(patch.privateKey) !== "") {
      this.settings.privateKey = patch.privateKey;
    }
    if (patch.walletAddress != null) this.settings.walletAddress = patch.walletAddress;
    if (patch.walletType != null) this.settings.walletType = patch.walletType;
    if (patch.proxyUrl != null) this.settings.proxyUrl = patch.proxyUrl;
    if (typeof this.live.configure === "function") {
      this.live.configure({
        privateKey: this.settings.privateKey,
        walletAddress: this.settings.walletAddress,
        walletType: this.settings.walletType,
      });
    }
    if (typeof this.live.deriveCredentials !== "function") {
      return { ok: false, reason: "unsupported_venue" };
    }
    const res = await this.live.deriveCredentials();
    if (!res.ok) {
      this.journal.write({ type: "derive_keys", ok: false, reason: res.reason });
      this.emit("log", { level: "error", message: `derive_keys_failed: ${res.reason}` });
      return res;
    }
    this.settings.apiKey = res.apiKey;
    this.settings.apiSecret = res.apiSecret;
    this.settings.apiPassphrase = res.apiPassphrase;
    this.journal.write({
      type: "derive_keys",
      ok: true,
      signerAddress: res.signerAddress,
      walletType: res.walletType,
    });
    await this.pingApi({});
    return res;
  }

  async refreshLiveBalance() {
    if (this.mode !== "auto") {
      this.liveBalance = {
        ok: true,
        value: this.paper.balance.toFixed(2),
        source: "paper",
        pulsing: false,
      };
      return this.liveBalance;
    }
    this.liveBalance = { ok: false, value: "0.00", source: "live", pulsing: true, reason: "checking" };
    this.emit("balance", this.liveBalance);
    try {
      const live = await this.live.ping();
      this.pingResult = { ...(this.pingResult || {}), live, at: Date.now() };
      if (!live.ok) {
        this.liveBalance = {
          ok: false,
          value: "0.00",
          source: "live",
          pulsing: true,
          reason: live.message || "unreachable",
        };
      } else {
        const bal = typeof this.live.getBalance === "function" ? await this.live.getBalance() : null;
        if (bal == null || bal === "") {
          this.liveBalance = {
            ok: false,
            value: "0.00",
            source: "live",
            pulsing: true,
            reason: "no_balance",
          };
        } else {
          this.liveBalance = { ok: true, value: String(bal), source: "live", pulsing: false };
        }
      }
    } catch (err) {
      this.liveBalance = {
        ok: false,
        value: "0.00",
        source: "live",
        pulsing: true,
        reason: String(err.message || err),
      };
    }
    this.emit("balance", this.liveBalance);
    return this.liveBalance;
  }

  _fastPeriod() {
    return fastPeriodOf(this.settings);
  }

  _slowPeriod() {
    return slowPeriodOf(this.settings);
  }

  /** Price for previews: the last live quote when there is one, else even odds. */
  _planPrice() {
    const p = this.lastQuote && Number(this.lastQuote.price);
    return p > 0 && p < 1 ? p : 0.5;
  }

  _planSchedule() {
    if (!this.lastQuote) return undefined;
    return { rate: this.lastQuote.feeRate, exponent: this.lastQuote.feeExponent };
  }

  _evalOptions() {
    return {
      minOpeningAtr: this.settings.minOpeningAtr,
      minCrossTicks: this.settings.minCrossTicks,
      tickSize: this.tickSize,
      confirmCount: confirmCountOf(this.settings),
      fastPeriod: this._fastPeriod(),
      slowPeriod: this._slowPeriod(),
      fullBodyOnS: fullBodyOnSOf(this.settings),
      maType: maTypeOf(this.settings),
    };
  }

  _tickFor(symbol) {
    const id = symbol || this.settings.symbol || "BTCUSDT";
    const row = (this.symbols || []).find((s) => s.id === id);
    const n = Number(row && row.tickSize);
    if (Number.isFinite(n) && n > 0) return n;
    return fallbackTick(id);
  }

  /**
   * Close out a live Polymarket bet when its round bar closes.
   * Money settles on the venue; this keeps the series, journal and chart
   * markers in sync and refreshes the real balance afterwards.
   */
  _settleLive(bar) {
    const bet = this.liveBet;
    if (!bet) return null;
    if (bet.roundCloseTs && bar.closeTs && bar.closeTs < bet.roundCloseTs) return null;
    const strike = Number(bet.strike);
    const close = Number(bar.close);
    const outcome = outcomeOf(close, strike);
    const won = bet.side === outcome;
    const size = Number(bet.sizeUsd);
    const entry = Number(bet.entryPrice);
    const shares =
      Number(bet.shares) > 0
        ? Number(bet.shares)
        : entry > 0 && entry < 1
          ? size / entry
          : size * (Number(bet.payout) > 1 ? Number(bet.payout) : 2);
    // taker fee is charged in USDC at match time, so it is lost on either outcome
    const fee = Number(bet.feeUsd) > 0 ? Number(bet.feeUsd) : 0;
    const pnl = Decimal((won ? shares - size : -size) - fee);
    const settled = {
      ...bet,
      mode: "auto",
      status: won ? "win" : "loss",
      outcome,
      settleClose: close,
      settledAt: Date.now(),
      holdMs: Date.now() - bet.placedAt,
      pnl: pnl.toFixed(2),
    };
    this.liveBet = null;
    if (won) this.risk.onWin();
    else this.risk.onLoss(-Number(settled.pnl));
    this.journal.write({ type: "settled", ...settled });
    this._markResult(settled);
    this.status = this.risk.halted ? "halt" : this.running ? "watching" : "stopped";
    this.emit("settled", settled);
    this.notify(
      settled.status,
      settled.status === "win" ? "Win" : "Loss",
      `${settled.side} \u00b7 $${settled.pnl} \u00b7 live`
    );
    if (this.risk.halted) {
      this.running = false;
      this.journal.write({ type: "halt" });
      this.emit("halt", this.risk.snapshot());
      this.notify("halt", "Series halted", `${this.risk.maxSteps} losses \u2014 confirm lot`);
    }
    this.refreshLiveBalance().catch(() => {});
    this._reconcileLive(settled);
    return settled;
  }

  /**
   * The series steps on the Binance close so the next bet is not delayed, but
   * Polymarket resolves on the Chainlink TWAP. Check the real resolution
   * afterwards and flag any disagreement loudly instead of hiding it.
   */
  _reconcileLive(settled, { attempts = 30, delayMs = 30_000 } = {}) {
    if (!settled.slug || typeof this.live.resolvedOutcome !== "function") return;
    let left = attempts;
    const tick = async () => {
      left -= 1;
      let res = null;
      try {
        res = await this.live.resolvedOutcome(settled.slug);
      } catch {
        res = null;
      }
      if (!res || !res.resolved) {
        if (left > 0) schedule();
        return;
      }
      if (res.outcome === settled.outcome) {
        this.journal.write({ type: "settle_confirmed", slug: settled.slug, outcome: res.outcome });
        return;
      }
      this.journal.write({
        type: "settle_mismatch",
        slug: settled.slug,
        local: settled.outcome,
        venue: res.outcome,
        side: settled.side,
        localPnl: settled.pnl,
      });
      this.emit("log", {
        level: "error",
        message: `settle_mismatch: ${settled.slug} booked ${settled.outcome}, Polymarket resolved ${res.outcome}`,
      });
      this.notify(
        "halt",
        "Result differs from Polymarket",
        `${settled.slug}: booked ${settled.outcome}, venue ${res.outcome} \u2014 check the series`
      );
      this.refreshLiveBalance().catch(() => {});
    };
    const schedule = () => {
      const timer = setTimeout(tick, delayMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    };
    schedule();
  }

  _settleIfOpen(bar) {
    const bet = this.openBet();
    if (bet && bet.roundCloseTs && bar.closeTs > bet.roundCloseTs) {
      const target = this.market.bars.find((b) => b.closeTs === bet.roundCloseTs);
      if (!target) {
        this.pause("missing_settlement_bar: waiting for the original round candle");
        return null;
      }
      bar = target;
    }
    if (this.mode === "auto") return this._settleLive(bar);
    if (!this.paper.openBet) return null;
    const settled = this.paper.settle(bar);
    if (!settled) return null;
    if (settled.status === "win") this.risk.onWin();
    else this.risk.onLoss(-Number(settled.pnl));
    this.journal.write({ type: "settled", ...settled });
    this._markResult(settled);
    this.status = this.risk.halted ? "halt" : this.running ? "watching" : "stopped";
    this.emit("settled", settled);
    this.notify(
      settled.status,
      settled.status === "win" ? "Win" : "Loss",
      `${settled.side} · $${settled.pnl} · bal $${settled.balanceAfter}`
    );
    if (this.risk.halted) {
      this.running = false;
      this.journal.write({ type: "halt" });
      this.emit("halt", this.risk.snapshot());
      this.notify("halt", "Series halted", `${this.risk.maxSteps} losses — confirm lot`);
    }
    return settled;
  }

  async onBarClose(bar) {
    const next = this._barQueue.then(() => this._processBarClose(bar));
    this._barQueue = next.catch(() => {});
    return next;
  }

  async _processBarClose(bar) {
    if (this.markers.length > HISTORY_BARS) this.markers.splice(0, this.markers.length - HISTORY_BARS);
    const bars = this.market.bars;
    let index = bars.findIndex((b) => b.openTs === bar.openTs);
    if (index < 0) {
      bars.push(bar);
      bars.sort((a, b) => a.openTs - b.openTs);
      index = bars.findIndex((b) => b.openTs === bar.openTs);
    }

    if (this.lastHandledOpenTs != null && bar.openTs <= this.lastHandledOpenTs) {
      return;
    }
    this.lastHandledOpenTs = bar.openTs;
    this._settleIfOpen(bar);

    if (!this.running) return;
    const interval = INTERVAL_MS[this.settings.timeframe || "15m"] || 900_000;
    if (bar.recovered && Date.now() >= bar.openTs + 2 * interval) {
      this.journal.write({ type: "skip", reason: "expired_recovered_signal", openTs: bar.openTs });
      return;
    }
    if (this._dailyLimitHit()) {
      this._hitDailyLimit();
      return;
    }
    if (this.risk.halted) {
      this.status = "halt";
      this.emit("status", this.status);
      return;
    }
    if (bars.length < this._slowPeriod()) {
      this.status = "warming_up";
      this.emit("status", this.status);
      return;
    }
    if (this.openBet()) return;

    const firstRequired = Math.max(0, index - Math.max(this._slowPeriod(), confirmCountOf(this.settings) + 2) + 1);
    for (let i = firstRequired + 1; i <= index; i += 1) {
      if (bars[i].openTs - bars[i - 1].openTs !== interval) {
        this.journal.write({ type: "skip", reason: "history_gap", openTs: bar.openTs });
        this.status = "warming_up";
        return;
      }
    }

    const ev = this.strategy().evaluate(bars, index, this._evalOptions());
    this.lastEval = { ...ev, bar };
    if (!ev.signal) {
      this.risk.onSkip();
      this.status = "watching";
      this.journal.write({
        type: "skip",
        reason: ev.reason,
        openTs: bar.openTs,
        o: bar.open,
        h: bar.high,
        l: bar.low,
        c: bar.close,
        ma20: ev.ma20,
        ma200: ev.ma200,
        signal: ev.signal,
      });
      this.emit("skip", this.lastEval);
      return;
    }
    await this._openFromSignal(ev, bar);
  }

  async _openFromSignal(ev, bar) {
    if (this._opening || this.journal.pendingOrder()) return null;
    this._opening = true;
    try {
      return await this._executeSignal(ev, bar);
    } finally {
      this._opening = false;
    }
  }

  _pauseUnknownOrder() {
    this._executionGeneration += 1;
    this.running = false;
    this._stopHealth();
    this.pauseReason = "order_outcome_unknown: check the order on Polymarket before resuming";
    this.status = "paused";
    this.emit("log", { level: "error", message: this.pauseReason });
    this.emit("status", this.status);
  }

  async _executeSignal(ev, bar) {
    const generation = this._executionGeneration;
    if (this.mode === "auto" && this._testPositionActive()) return null;
    if (this.openBet()) return null;
    if (!this.risk.canOpen()) {
      this.status = this.risk.halted ? "halt" : "watching";
      this.emit("status", this.status);
      return null;
    }
    const interval = INTERVAL_MS[this.settings.timeframe || "15m"] || 900_000;
    const sClose = bar.closeTs || bar.openTs + interval - 1;
    const round = {
      strike: bar.close,
      openTs: sClose + 1,
      closeTs: sClose + interval,
    };
    // The stake depends on the entry price (recovery sizing), so price first.
    const quote = await this._quoteFor(ev.signal, round);
    if (generation !== this._executionGeneration) return null;
    if (this.mode === "auto" && !quote) {
      // No price means no order: say so and count it, never skip rounds silently.
      this.journal.write({ type: "skip", reason: "venue_unavailable", signal: ev.signal, openTs: bar.openTs });
      this.notify("halt", "Round skipped", `${ev.signal}: Polymarket quote unavailable`);
      this.status = "watching";
      this._venueFailed("no quote at signal");
      return null;
    }
    if (this.mode === "auto") this._venueOk();
    const schedule = quote ? { rate: quote.feeRate, exponent: quote.feeExponent } : undefined;
    const maxPrice = maxEntryPriceOf(this.settings.maxEntryPrice);
    if (quote && maxPrice < 1 && Number(quote.price) > maxPrice) {
      this.risk.onSkip();
      this.status = "watching";
      this.journal.write({ type: "skip", reason: "price_above_max", price: quote.price, maxEntryPrice: maxPrice, signal: ev.signal, openTs: bar.openTs });
      this.emit("log", { level: "info", message: `skip_price: ${ev.signal} ask ${quote.price} > ${maxPrice}` });
      this.emit("skip", { ...ev, reason: "price_above_max", bar });
      return null;
    }
    const entryPrice = quote ? quote.price : undefined;
    const size = this.risk.size(entryPrice, schedule).toFixed(2);
    const maxTotalCostUsd = this._entryBudget();
    const lossCost = Math.ceil(Number(size) * perDollar(entryPrice, schedule).loss * 100 - 1e-9) / 100;
    if (lossCost > maxTotalCostUsd + 1e-9) {
      this.pause("budget_exceeded: stake and fee exceed the remaining series or daily budget");
      this.journal.write({ type: "budget_blocked", sizeUsd: size, lossCost, remainingUsd: maxTotalCostUsd });
      return null;
    }
    if (this.risk.isCapped(entryPrice, schedule)) {
      const needed = this.risk.rawSize(entryPrice, schedule).toFixed(2);
      this.journal.write({ type: "stake_capped", needed, cap: this.risk.maxStakeUsd, step: this.risk.step });
      this.emit("log", { level: "warn", message: `stake_capped: needed $${needed}, cap $${this.risk.maxStakeUsd} — a win will not recover the series` });
    }
    const clientOrderId = `${new Date(bar.openTs).toISOString().slice(0, 10)}-${this.settings.timeframe || "15m"}-${bar.openTs}-${ev.signal}-${this.risk.step}`;
    const marker = {
      time: Math.floor(round.openTs / 1000),
      side: ev.signal,
      size,
      virtual: this.mode !== "auto",
    };
    this.journal.write({
      type: "setup",
      reason: ev.reason,
      openTs: bar.openTs,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      ma20: ev.ma20,
      ma200: ev.ma200,
      signal: ev.signal,
    });
    this.notify("setup", `${ev.signal} setup`, `${this.strategy().name} · $${size} · S+1`);

    if (this.mode === "auto") {
      // Live trading path — requires L2 + privateKey in the venue
      const liveReady = typeof this.live.hasPrivateKey === "function"
        ? this.live.hasPrivateKey()
        : Boolean(this.settings.privateKey);

      if (!liveReady) {
        this.journal.write({ type: "auto_blocked", reason: "no_private_key" });
        this.emit("log", { level: "warn", message: "auto_blocked: privateKey not set" });
        this.status = "watching";
        this.markers.push({ ...marker, virtual: true });
        this.emit("signal", { ...ev, paper: true, size });
        return null;
      }

      let accepted = false;
      try {
        this.status = "order_sent";
        this.emit("status", this.status);
        const dryRun = this.isDryRun();
        if (!dryRun) this.journal.beginOrder({ clientOrderId, side: ev.signal, sizeUsd: size, round });
        const order = await this.live.marketBuy({
          side: ev.signal,
          sizeUsd: size,
          clientOrderId,
          round,
          dryRun,
          maxPrice,
          maxTotalCostUsd,
          isActive: () => generation === this._executionGeneration,
        });
        accepted = true;
        this.orderRejects = 0;
        if (order.fokRetried) this.emit("log", { level: "warn", message: "order_retried: first order was not filled, placed again on a fresh book" });
        if (order.partial) {
          this.journal.write({ type: "partial_fill", requested: size, filled: order.sizeUsd, shares: order.shares });
          this.emit("log", { level: "warn", message: `partial_fill: $${order.sizeUsd} of $${size} filled, booked as filled` });
        }
        this.liveBet = {
          dryRun,
          clientOrderId,
          side: ev.signal,
          sizeUsd: order.sizeUsd || size,
          payout: order.payout || (quote && quote.payout) || null,
          entryPrice: order.price || (quote && quote.price) || null,
          shares: order.shares || null,
          feeUsd: order.feeUsd || null,
          orderId: order.orderId || null,
          slug: order.slug || (quote && quote.slug) || null,
          strike: round.strike,
          roundOpenTs: round.openTs,
          roundCloseTs: round.closeTs,
          placedAt: Date.now(),
          status: "open",
        };
        this.markers.push(marker);
        this.journal.write({ type: "order_sent", mode: "auto", dryRun, ...order });
        this.journal.completeOrder(clientOrderId);
        this.status = "waiting_settlement";
        this.emit("order", { ...order, live: !dryRun });
        this.notify(
          "order",
          `${dryRun ? "Dry run" : "Live"} ${ev.signal}`,
          `$${order.sizeUsd || size} @ ${order.price || "?"} · strike ${Number(bar.close).toFixed(2)}`
        );
        return order;
      } catch (err) {
        if (!err.ambiguous && !accepted) this.journal.completeOrder(clientOrderId);
        const message = String(err.message || err);
        this.journal.write({ type: "order_error", mode: "auto", code: err.code || null, message });
        this.status = "watching";
        this.emit("log", { level: "error", message: `live_order_error: ${message}` });
        this._onOrderError(err, message);
        if (err.code === "budget_exceeded") this.pause("budget_exceeded: refreshed order cost exceeds the remaining budget");
        if (err.ambiguous || accepted) this._pauseUnknownOrder();
        return null;
      }
    }

    // Paper path
    try {
      this.status = "order_sent";
      const order = await this.paper.marketBuy({
        side: ev.signal,
        sizeUsd: size,
        clientOrderId,
        round,
        price: quote ? quote.price : null,
        feeRate: quote ? quote.feeRate : null,
        feeExponent: quote ? quote.feeExponent : null,
        quoteSource: quote ? "polymarket" : "assumed_0.50",
      });
      if (quote && Number(quote.minOrderSize) > 0 && Number(order.shares) < Number(quote.minOrderSize)) {
        // Paper still books it, but the same lot would be refused live.
        const minUsd = (Number(quote.minOrderSize) * Number(order.entryPrice)).toFixed(2);
        this.journal.write({ type: "paper_below_live_min", shares: order.shares, minOrderSize: quote.minOrderSize, minUsd });
        this.emit("log", {
          level: "warn",
          message: `paper_below_live_min: ${order.shares} shares < ${quote.minOrderSize}; live needs at least $${minUsd}`,
        });
      }
      this.markers.push(marker);
      this.journal.write({ type: "order_sent", ...order });
      this.status = "waiting_settlement";
      this.emit("order", order);
      this.notify(
        "order",
        `Paper ${ev.signal}`,
        `$${size} + fee $${order.feeUsd} · strike ${Number(bar.close).toFixed(2)}`
      );
      return order;
    } catch (err) {
      this.journal.write({ type: "order_error", message: String(err.message || err) });
      this.status = "watching";
      this.emit("log", { level: "error", message: String(err.message || err) });
      return null;
    }
  }

  /**
   * Decide whether a failed live order should stop Auto. Anything that will
   * fail the same way on the next signal pauses; transient issues are counted.
   */
  _onOrderError(err, message) {
    const code = err && err.code;
    const status = err && err.response ? Number(err.response.status) : null;
    if (code === "insufficient_balance" || code === "below_min_size" || code === "auto_not_wired" || code === "geoblocked") {
      this.pause(`${code}: ${message}`);
      return;
    }
    // wrong proxy address, login or scheme: the next order fails identically
    if (err && /^proxy_(auth|invalid|host)$/.test(String(err.networkCode || ""))) {
      this.pause(`${err.networkCode}: ${message}`);
      return;
    }
    if (code === "round_closed") return;
    if (code === "clob_order_rejected" && status !== 0 && !(status >= 500)) {
      this.orderRejects += 1;
      if (this.orderRejects >= REJECT_LIMIT) this.pause(`orders_rejected: ${message}`);
      return;
    }
    this._venueFailed(`order: ${message}`);
  }

  _markResult(settled) {
    const marker = [...this.markers].reverse().find((m) => m.side === settled.side && !m.result);
    if (marker) marker.result = settled.status;
  }

  _entryBudget() {
    const series = Number(this.risk.maxSeriesLossUsd) > 0
      ? Math.max(0, this.risk.maxSeriesLossUsd - this.risk.seriesLossUsd) : Infinity;
    const daily = this.dailyLossLimit() > 0
      ? Math.max(0, this.dailyLossLimit() + this.todayPnl()) : Infinity;
    return Math.min(series, daily);
  }

  snapshot() {
    const forming = this.market.forming
      ? {
          time: Math.floor(this.market.forming.openTs / 1000),
          open: this.market.forming.open,
          high: this.market.forming.high,
          low: this.market.forming.low,
          close: this.market.forming.close,
        }
      : null;
    const lastClose = forming
      ? forming.close
      : this.market.bars.length
        ? this.market.bars[this.market.bars.length - 1].close
        : null;
    return {
      version: require("../../package.json").version,
      running: this.running,
      status: this.status,
      mode: this.mode,
      strategyId: this.strategyId,
      strategyName: this.strategy().name,
      strategies: listStrategies(),
      symbols: (this.symbols && this.symbols.length ? this.symbols : SYMBOLS).map((s) => ({
        ...s,
        polymarket: isSupportedSymbol(s.id),
      })),
      timeframes: TIMEFRAMES,
      polymarketTimeframes: SUPPORTED_TF.slice(),
      settings: {
        symbol: this.settings.symbol || "BTCUSDT",
        timeframe: this.settings.timeframe || "15m",
        baseUsd: this.risk.baseUsd.toFixed(2),
        maxSteps: this.risk.maxSteps,
        sizingMode: this.risk.sizingMode,
        maxStakeUsd: this.risk.maxStakeUsd,
        fixedStakes: this.risk.fixedStakes.slice(),
        maxSeriesLossUsd: this.risk.maxSeriesLossUsd,
        maxEntryPrice: maxEntryPriceOf(this.settings.maxEntryPrice),
        dryRun: this.isDryRun(),
        dailyLossLimitUsd: this.dailyLossLimit(),
        theme: ["glass-dark", "glass-light", "glass-blue"].includes(this.settings.theme) ? this.settings.theme : "glass-dark",
        locale: this.settings.locale || "en",
        strategyId: this.strategyId,
        minOpeningAtr: Number(this.settings.minOpeningAtr || 0),
        minCrossTicks: Number(this.settings.minCrossTicks || 0),
        venue: "polymarket",
        confirmCount: confirmCountOf(this.settings),
        fastPeriod: this._fastPeriod(),
        slowPeriod: this._slowPeriod(),
        fullBodyOnS: fullBodyOnSOf(this.settings),
        maType: maTypeOf(this.settings),
        apiKey: this.settings.apiKey ? "set" : "",
        hasApiKey: Boolean(this.settings.apiKey),
        hasApiSecret: Boolean(this.settings.apiSecret),
        hasApiPassphrase: Boolean(this.settings.apiPassphrase),
        walletAddress: this.settings.walletAddress || "",
        hasPrivKey: Boolean(this.settings.privateKey),
        walletType: this.settings.walletType || "AUTO",
        detectedWalletType:
          typeof this.live.detectedWalletType === "function" ? this.live.detectedWalletType() : null,
        proxyUrl: this.settings.proxyUrl || "",
        signerAddress: typeof this.live.signerAddress === "function" ? this.live.signerAddress() : null,
        refreshMs: clampRefreshMs(this.settings.refreshMs || 100),
        notificationsEnabled: this.notificationsEnabled !== false,
        paperBalance: this.settings.paperBalance || "1000.00",
        tickSize: this.tickSize,
      },
      pairLabel: `${symbolLabel(this.settings.symbol || "BTCUSDT")} · ${this.settings.timeframe || "15m"}`,
      lastPrice: lastClose,
      risk: this.risk.snapshot(this._planPrice(), this._planSchedule()),
      plan: this.risk.plan(this._planPrice(), this._planSchedule()),
      stats: computeStats(this.journal.entries, { book: this._book(), maxSteps: this.risk.maxSteps }),
      book: this._book(),
      daily: dailyBreakdown(this.journal.entries, this._book(), 14),
      pauseReason: this.pauseReason,
      settingsLocked: Boolean(this._opening || this.openBet() || this._testPositionActive() || this.journal.pendingOrder() || this.risk.consecutiveLosses > 0),
      orderPending: Boolean(this._opening || this.journal.pendingOrder()),
      testPositionActive: Boolean(this._testPositionActive()),
      lastConnect: this.lastConnect || null,
      paper: this.paper.snapshot(),
      liveBalance: this.liveBalance,
      liveBet: this.liveBet,
      quote: this.lastQuote,
      ping: this.pingResult,
      lastEval: this.lastEval,
      markers: this.markers.slice(-200),
      todayPnl: this.todayPnl().toFixed(2),
      barsReady: this.market.bars.length,
      bars: this.market.bars.map((b) => ({
        time: Math.floor(b.openTs / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
      forming,
      log: this.journal.tail(40),
    };
  }
}

module.exports = { Engine, STATUSES };
