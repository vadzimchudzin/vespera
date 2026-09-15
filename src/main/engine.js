"use strict";

const { evaluateBar } = require("./strategy");
const { Risk } = require("./risk");
const { MarketData, INTERVAL_MS } = require("./marketData");
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
      });
    this.markers = [];
    this.lastEval = null;
    this.pingResult = null;
    this.todayPnl = Decimal("0");
    this.lastHandledOpenTs = null;
    this._bindMarket();
  }

  broker() {
    return this.mode === "auto" ? this.live : this.paper;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners) fn({ type, payload, state: this.snapshot() });
  }

  _bindMarket() {
    this.market.on((event, payload) => {
      if (event === "history") {
        this._replayMarkers();
        this.emit("history", payload);
      }
      if (event === "bar_close") {
        this.onBarClose(payload);
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

  _replayMarkers() {
    if (this.markers.length) return;
    const bars = this.market.bars;
    for (let i = 199; i < bars.length; i += 1) {
      const ev = evaluateBar(bars, i, {
        requirePriorPenetration: this.settings.requirePriorPenetration,
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
    if (!this.market.timer && typeof this.market.start === "function") {
      this.market.start();
    }
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
    if (typeof this.market.loadHistory === "function") {
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
    if (!this.paper.openBet && typeof this.market.stop === "function") {
      this.market.stop();
    }
    this.status = this.paper.openBet ? "waiting_settlement" : "stopped";
    this.journal.write({ type: "stop" });
    this.emit("status", this.status);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (this.paper.openBet) {
      this.emit("log", { level: "warn", message: "mode_blocked_open_bet" });
      return;
    }
    this.mode = mode;
    this.risk.step = 1;
    this.risk.consecutiveLosses = 0;
    this.journal.write({ type: "mode", mode });
    this.emit("mode", mode);
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
    this.emit("ping", this.pingResult);
    return this.pingResult;
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
        if (!this.running && typeof this.market.stop === "function") {
          this.market.stop();
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

    const ev = evaluateBar(bars, index, {
      requirePriorPenetration: this.settings.requirePriorPenetration,
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
    return {
      version: "0.1.0",
      running: this.running,
      status: this.status,
      mode: this.mode,
      settings: {
        symbol: this.settings.symbol || "BTCUSDT",
        timeframe: this.settings.timeframe || "15m",
        baseUsd: this.risk.baseUsd.toFixed(2),
        maxSteps: this.risk.maxSteps,
        theme: this.settings.theme || "glass-dark",
        locale: this.settings.locale || "en",
      },
      risk: this.risk.snapshot(),
      paper: this.paper.snapshot(),
      ping: this.pingResult,
      lastEval: this.lastEval,
      markers: this.markers.slice(-40),
      todayPnl: this.todayPnl.toFixed(2),
      barsReady: this.market.bars.length,
      log: this.journal.tail(40),
    };
  }
}

module.exports = { Engine, STATUSES };
