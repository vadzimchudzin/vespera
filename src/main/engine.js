"use strict";

const { getStrategy, listStrategies, DEFAULT_STRATEGY_ID } = require("./strategies/catalog");
const { Risk } = require("./risk");
const { MarketData } = require("./marketData");
const { INTERVAL_MS, SYMBOLS, TIMEFRAMES, clampRefreshMs, symbolLabel } = require("./markets");
const { PaperBroker } = require("./paperBroker");
const { PreddyAdapter } = require("./predicAdapter");
const { Journal } = require("./journal");
const { Decimal } = require("./money");

const STATUSES = [
  "stopped",
  "warming_up",
  "watching",
  "order_sent",
  "waiting_settlement",
  "halt",
];

class Engine {
  constructor({ userDataDir, settings, market } = {}) {
    this.userDataDir = userDataDir;
    this.settings = settings || {};
    this.running = false;
    this.status = "stopped";
    this.mode = this.settings.mode || "paper";
    this.listeners = new Set();
    this.journal = new Journal(`${userDataDir}/journal.jsonl`);
    this.risk = new Risk({
      baseUsd: this.settings.baseUsd || "1.00",
      maxSteps: this.settings.maxSteps || 6,
    });
    const restored = this.journal.restoreRisk();
    this.risk.step = restored.step;
    this.risk.consecutiveLosses = restored.consecutiveLosses;
    this.risk.halted = restored.halted;
    if (restored.halted) this.risk.lotConfirmed = false;
    this.paper = new PaperBroker({ startingBalance: this.settings.paperBalance || "1000.00" });
    this._restorePaper();
    this.live = new PreddyAdapter({
      apiKey: this.settings.apiKey || "",
      baseUrl: this.settings.apiBase || "https://preddy.trade",
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
    this.liveBalance = {
      ok: true,
      value: this.paper.balance.toFixed(2),
      source: "paper",
      pulsing: false,
    };
    this.todayPnl = Decimal("0");
    this.lastHandledOpenTs = null;
    this.strategyId = this.settings.strategyId || DEFAULT_STRATEGY_ID;
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
        this._replayMarkers();
        this.emit("history", payload);
      }
      if (event === "bar_close") {
        this.onBarClose(payload);
        if (!this.running) {
          this.emit("history", { bars: this.market.bars, forming: this.market.forming });
        }
      }
      if (event === "tick") {
        this.emit("tick", payload);
      }
      if (event === "error") {
        this.journal.write({ type: "data_error", message: payload });
        this.emit("log", { level: "error", message: payload });
      }
    });
  }

  _restorePaper() {
    const lastSettled = [...this.journal.entries].reverse().find((e) => e.type === "settled");
    if (lastSettled && lastSettled.balanceAfter) {
      this.paper.balance = Decimal(lastSettled.balanceAfter);
    }
    const open = this.journal.lastOpenBet();
    if (open && open.side && open.sizeUsd) {
      this.paper.openBet = {
        clientOrderId: open.clientOrderId,
        side: open.side,
        sizeUsd: open.sizeUsd,
        strike: open.strike,
        roundOpenTs: open.roundOpenTs,
        roundCloseTs: open.roundCloseTs,
        placedAt: open.placedAt || Date.now(),
        status: "open",
      };
    }
  }

  _replayMarkers(force = false) {
    if (this.markers.length && !force) return;
    this.markers = [];
    const bars = this.market.bars;
    for (let i = 199; i < bars.length; i += 1) {
      const ev = this.strategy().evaluate(bars, i, {
        requirePriorPenetration: this.settings.requirePriorPenetration,
        minOpeningAtr: this.settings.minOpeningAtr,
      });
      if (ev.signal) {
        this.markers.push({
          time: Math.floor(bars[i].openTs / 1000),
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

  async applySettings(patch = {}) {
    const next = { ...this.settings, ...patch };
    if (patch.refreshMs != null) {
      next.refreshMs = clampRefreshMs(patch.refreshMs);
      if (typeof this.market.setRefreshMs === "function") {
        this.market.setRefreshMs(next.refreshMs);
      }
    }
    if (patch.minOpeningAtr != null) {
      next.minOpeningAtr = Number(patch.minOpeningAtr);
    }
    if (patch.maxSteps != null) {
      this.risk.maxSteps = Number(patch.maxSteps);
    }
    if (patch.baseUsd != null) {
      this.settings.baseUsd = Decimal(patch.baseUsd).toFixed(2);
    }
    const symbol = next.symbol || this.settings.symbol || "BTCUSDT";
    const timeframe = next.timeframe || this.settings.timeframe || "15m";
    const marketChanged = symbol !== (this.settings.symbol || "BTCUSDT") || timeframe !== (this.settings.timeframe || "15m");
    this.settings = next;
    if (marketChanged && typeof this.market.configure === "function") {
      await this.market.configure({
        symbol,
        timeframe,
        refreshMs: next.refreshMs,
      });
      this.markers = [];
      this.lastEval = null;
      this.lastHandledOpenTs = null;
      this._replayMarkers(true);
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    } else if (patch.minOpeningAtr != null) {
      this._replayMarkers(true);
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    }
    return this.snapshot();
  }

  async warmChart() {
    try {
      if (typeof this.market.loadHistory === "function") {
        await this.market.loadHistory(500);
      }
      this._replayMarkers(true);
      this._ensureMarket();
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    } catch (err) {
      this.journal.write({ type: "data_error", message: String(err.message || err) });
      this.emit("log", { level: "error", message: String(err.message || err) });
    }
    return this.snapshot();
  }

  async start() {
    if (this.risk.halted || !this.risk.lotConfirmed) {
      this.running = false;
      this.status = "halt";
      this.emit("status", this.status);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.status = "warming_up";
    this.emit("status", this.status);
    if (typeof this.market.loadHistory === "function" && this.market.bars.length < 200) {
      await this.market.loadHistory(500);
    }
    const last = this.market.bars[this.market.bars.length - 1];
    if (last) this.lastHandledOpenTs = last.openTs;
    this._ensureMarket();
    if (this.market.bars.length < 200) {
      this.status = "warming_up";
    } else {
      this.status = this.paper.openBet ? "waiting_settlement" : "watching";
    }
    this.journal.write({ type: "start", mode: this.mode });
    this.emit("status", this.status);
  }

  stop() {
    this.running = false;
    this.status = this.paper.openBet ? "waiting_settlement" : "stopped";
    this.journal.write({ type: "stop" });
    this.emit("status", this.status);
  }

  async setMode(mode) {
    if (mode === this.mode) {
      if (mode === "auto") await this.refreshLiveBalance();
      return this.snapshot();
    }
    if (this.paper.openBet) {
      this.emit("log", { level: "warn", message: "mode_blocked_open_bet" });
      return this.snapshot();
    }
    this.mode = mode;
    this.risk.step = 1;
    this.risk.consecutiveLosses = 0;
    this.journal.write({ type: "mode", mode });
    if (mode === "auto") {
      await this.refreshLiveBalance();
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

  confirmLot(baseUsd) {
    this.risk.confirmLot(baseUsd);
    this.settings.baseUsd = Decimal(baseUsd).toFixed(2);
    this.journal.write({ type: "lot_confirmed", baseUsd: this.settings.baseUsd });
    if (this.running) {
      this.status = this.paper.openBet ? "waiting_settlement" : "watching";
      this._ensureMarket();
    }
    this.emit("status", this.status);
  }

  async pingApi(apiKey) {
    this.settings.apiKey = apiKey;
    this.live.apiKey = apiKey;
    const paper = await this.paper.ping();
    const live = await this.live.ping();
    this.pingResult = { paper, live, at: Date.now() };
    this.journal.write({ type: "api_ping", paper, live: { ...live, apiKey: undefined } });
    if (this.mode === "auto") await this.refreshLiveBalance();
    this.emit("ping", this.pingResult);
    return this.pingResult;
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

  async onBarClose(bar) {
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

    if (this.paper.openBet) {
      const settled = this.paper.settle(bar);
      if (settled) {
        this.todayPnl = this.todayPnl.add(settled.pnl);
        if (settled.status === "win") this.risk.onWin();
        else this.risk.onLoss();
        this.journal.write({ type: "settled", ...settled });
        this._markResult(settled);
        this.status = this.risk.halted ? "halt" : this.running ? "watching" : "stopped";
        this.emit("settled", settled);
        if (this.risk.halted) {
          this.running = false;
          this.journal.write({ type: "halt" });
          this.emit("halt", this.risk.snapshot());
        }
      }
    }

    if (!this.running) return;
    if (this.risk.halted) {
      this.status = "halt";
      this.emit("status", this.status);
      return;
    }
    if (bars.length < 200) {
      this.status = "warming_up";
      this.emit("status", this.status);
      return;
    }

    const ev = this.strategy().evaluate(bars, index, {
      requirePriorPenetration: this.settings.requirePriorPenetration,
      minOpeningAtr: this.settings.minOpeningAtr,
    });
    this.lastEval = { ...ev, bar };
    this.journal.write({
      type: ev.signal ? "setup" : "skip",
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

    if (!ev.signal) {
      this.risk.onSkip();
      this.status = "watching";
      this.emit("skip", this.lastEval);
      return;
    }

    if (this.paper.openBet) return;
    if (!this.risk.canOpen()) {
      this.status = this.risk.halted ? "halt" : "watching";
      this.emit("status", this.status);
      return;
    }

    const size = this.risk.size().toFixed(2);
    const interval = INTERVAL_MS[this.settings.timeframe || "15m"];
    const round = {
      strike: bar.close,
      openTs: (bar.closeTs || bar.openTs + interval) + 1,
      closeTs: (bar.closeTs || bar.openTs + interval) + interval,
    };
    const clientOrderId = `${new Date(bar.openTs).toISOString().slice(0, 10)}-${this.settings.timeframe || "15m"}-${bar.openTs}-${ev.signal}-${this.risk.step}`;

    this.markers.push({
      time: Math.floor(bar.openTs / 1000),
      side: ev.signal,
      size,
      virtual: this.mode !== "auto",
    });

    if (this.mode === "auto") {
      this.journal.write({ type: "auto_blocked", reason: "auto_not_wired" });
      this.emit("log", { level: "warn", message: "auto_not_wired" });
      this.status = "watching";
      this.emit("signal", { ...ev, paper: true, size });
      return;
    }

    try {
      this.status = "order_sent";
      const order = await this.paper.marketBuy({
        side: ev.signal,
        sizeUsd: size,
        clientOrderId,
        round,
      });
      this.journal.write({ type: "order_sent", ...order });
      this.status = "waiting_settlement";
      this.emit("order", order);
    } catch (err) {
      this.journal.write({ type: "order_error", message: String(err.message || err) });
      this.status = "watching";
      this.emit("log", { level: "error", message: String(err.message || err) });
    }
  }

  _markResult(settled) {
    const marker = [...this.markers].reverse().find((m) => m.side === settled.side && !m.result);
    if (marker) marker.result = settled.status;
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
      version: "0.3.0",
      running: this.running,
      status: this.status,
      mode: this.mode,
      strategyId: this.strategyId,
      strategyName: this.strategy().name,
      strategies: listStrategies(),
      symbols: SYMBOLS,
      timeframes: TIMEFRAMES,
      settings: {
        symbol: this.settings.symbol || "BTCUSDT",
        timeframe: this.settings.timeframe || "15m",
        baseUsd: this.risk.baseUsd.toFixed(2),
        maxSteps: this.risk.maxSteps,
        theme: this.settings.theme || "glass-dark",
        locale: this.settings.locale || "en",
        strategyId: this.strategyId,
        minOpeningAtr: Number(this.settings.minOpeningAtr || 0),
        refreshMs: clampRefreshMs(this.settings.refreshMs || 100),
      },
      pairLabel: `${symbolLabel(this.settings.symbol || "BTCUSDT")} · ${this.settings.timeframe || "15m"}`,
      lastPrice: lastClose,
      risk: this.risk.snapshot(),
      paper: this.paper.snapshot(),
      liveBalance: this.liveBalance,
      ping: this.pingResult,
      lastEval: this.lastEval,
      markers: this.running ? this.markers.slice(-80) : [],
      todayPnl: this.todayPnl.toFixed(2),
      barsReady: this.market.bars.length,
      bars: this.market.bars.slice(-400).map((b) => ({
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
