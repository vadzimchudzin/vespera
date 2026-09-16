"use strict";

const { getStrategy, listStrategies, DEFAULT_STRATEGY_ID } = require("./strategies/catalog");
const { Risk } = require("./risk");
const { MarketData } = require("./marketData");
const { INTERVAL_MS, SYMBOLS, TIMEFRAMES, HISTORY_BARS, clampRefreshMs, symbolLabel, fallbackTick, fetchExchangeSymbols } = require("./markets");
const { createVenue } = require("./brokers");
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
    this.paper = createVenue("paper", { startingBalance: this.settings.paperBalance || "1000.00" });
    this._restorePaper();
    this.live = createVenue("auto", {
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
        this.onBarClose(payload);
        this.emit("bar", payload);
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

  async applySettings(patch = {}) {
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
    if (patch.maxSteps != null) {
      this.risk.maxSteps = Math.max(1, Number(patch.maxSteps) || 1);
    }
    if (patch.notificationsEnabled != null) {
      next.notificationsEnabled = Boolean(patch.notificationsEnabled);
      this.notificationsEnabled = next.notificationsEnabled;
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
      this.tickSize = this._tickFor(symbol);
      this.markers = [];
      this.lastEval = null;
      this.lastHandledOpenTs = null;
      this._replayMarkers(true);
      this.emit("history", { bars: this.market.bars, forming: this.market.forming });
    } else if (patch.minOpeningAtr != null || patch.minCrossTicks != null) {
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
      await this.market.loadHistory(HISTORY_BARS);
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

  resetPaper(startingBalance) {
    if (this.paper.openBet) {
      this.emit("log", { level: "warn", message: "reset_blocked_open_bet" });
      return this.snapshot();
    }
    const start = startingBalance || this.settings.paperBalance || "1000.00";
    this.paper.reset(start);
    this.todayPnl = Decimal("0");
    this.risk.step = 1;
    this.risk.consecutiveLosses = 0;
    this.risk.halted = false;
    this.risk.lotConfirmed = true;
    this.journal.write({ type: "paper_reset", balance: this.paper.balance.toFixed(2) });
    this.emit("balance", { ok: true, value: this.paper.balance.toFixed(2), source: "paper" });
    return this.snapshot();
  }

  notify(kind, title, body) {
    if (!this.notificationsEnabled) return;
    this.emit("notify", { kind, title, body, at: Date.now() });
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

  _evalOptions() {
    return {
      minOpeningAtr: this.settings.minOpeningAtr,
      minCrossTicks: this.settings.minCrossTicks,
      tickSize: this.tickSize,
    };
  }

  _tickFor(symbol) {
    const id = symbol || this.settings.symbol || "BTCUSDT";
    const row = (this.symbols || []).find((s) => s.id === id);
    const n = Number(row && row.tickSize);
    if (Number.isFinite(n) && n > 0) return n;
    return fallbackTick(id);
  }

  _settleIfOpen(bar) {
    if (!this.paper.openBet) return null;
    const settled = this.paper.settle(bar);
    if (!settled) return null;
    this.todayPnl = this.todayPnl.add(settled.pnl);
    if (settled.status === "win") this.risk.onWin();
    else this.risk.onLoss();
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
    if (this.paper.openBet) return;

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
    if (this.paper.openBet) return null;
    if (!this.risk.canOpen()) {
      this.status = this.risk.halted ? "halt" : "watching";
      this.emit("status", this.status);
      return null;
    }
    const size = this.risk.size().toFixed(2);
    const interval = INTERVAL_MS[this.settings.timeframe || "15m"] || 900_000;
    const sClose = bar.closeTs || bar.openTs + interval - 1;
    const round = {
      strike: bar.close,
      openTs: sClose + 1,
      closeTs: sClose + interval,
    };
    const clientOrderId = `${new Date(bar.openTs).toISOString().slice(0, 10)}-${this.settings.timeframe || "15m"}-${bar.openTs}-${ev.signal}-${this.risk.step}`;
    this.markers.push({
      time: Math.floor(round.openTs / 1000),
      side: ev.signal,
      size,
      virtual: this.mode !== "auto",
    });
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
    this.notify("setup", `${ev.signal} setup`, `SMA200/20 · $${size} · S+1`);

    if (this.mode === "auto") {
      this.journal.write({ type: "auto_blocked", reason: "auto_not_wired" });
      this.emit("log", { level: "warn", message: "auto_not_wired" });
      this.status = "watching";
      this.emit("signal", { ...ev, paper: true, size });
      return null;
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
      version: "0.8.3",
      running: this.running,
      status: this.status,
      mode: this.mode,
      strategyId: this.strategyId,
      strategyName: this.strategy().name,
      strategies: listStrategies(),
      symbols: this.symbols && this.symbols.length ? this.symbols : SYMBOLS,
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
        minCrossTicks: Number(this.settings.minCrossTicks || 0),
        refreshMs: clampRefreshMs(this.settings.refreshMs || 100),
        notificationsEnabled: this.notificationsEnabled !== false,
        paperBalance: this.settings.paperBalance || "1000.00",
        tickSize: this.tickSize,
      },
      pairLabel: `${symbolLabel(this.settings.symbol || "BTCUSDT")} · ${this.settings.timeframe || "15m"}`,
      lastPrice: lastClose,
      risk: this.risk.snapshot(),
      paper: this.paper.snapshot(),
      liveBalance: this.liveBalance,
      ping: this.pingResult,
      lastEval: this.lastEval,
      markers: this.markers.slice(-200),
      todayPnl: this.todayPnl.toFixed(2),
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
