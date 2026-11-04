"use strict";

// The agents desk: a team of paper-trading agents on Polymarket's real order books. Every minute each active agent
// screens the catalog (refreshed every refreshMin), the desk confirms the candidates on fresh books, sizes them
// within the limits and fills them on paper; positions are marked to the books and held to resolution. Nothing here
// can reach a venue: the paper book is the only executor, and any other mode is refused until the live-trading
// certificate (M6) exists.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createNet } = require("./net");
const MK = require("./market");
const M = require("./models");
const SC = require("./scanners");
const { Sources } = require("./sources");
const { PaperBook, freshBook, MAX_OPEN } = require("./paper");
const { capacity, haltCheck, limitName, MAX_PER_MATCH, matchCount } = require("./risk");
const R = require("./roster");
const { Brain } = require("./brain");
const { DEFAULT_CONFIG, LIMITS, fail, isRecord, num, dayKey, validateConfig, initialState, validateState } = require("./state");

const TICK_MS = 60000;
const DAY_MS = 86400000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
const TAIL_ROWS = 100;
const MAX_BOOK_TOKENS = 800;
const MAX_TRADES_PER_TICK = 10;
const COOLDOWN_MS = Object.freeze({ arb: 5 * 60000, single: 60 * 60000, skip: 5 * 60000 });
const SETTLE_MS = 10 * 60000;
const ROSTER_MS = 60 * 60000;
const CHECK_MS = 30 * 60000;
const PLAN_MS = DAY_MS;
const PERSIST_MS = 10 * 60000;
const FORECAST_TTL_MS = DAY_MS;
const CHECK_TTL_MS = 12 * 3600000;
const SHRINK = Object.freeze({ low: 0.15, medium: 0.3, high: 0.45 });
const DECIDED = Object.freeze({ p: 0.985, w: 0.6 });

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const sum = (rows, f) => rows.reduce((s, row) => s + f(row), 0);
const who = (by) => (by === "telegram" ? "telegram" : "ui");
const codeOf = (error, fallback) => (typeof error?.code === "string" && /^(agents|ai)_[a-z0-9_]+$/.test(error.code) ? error.code : fallback);

// Takes what a paper fill bought out of the snapshot, so a second trade in the same minute meets the rest of the book.
function consume(books, market, side, shares) {
  const book = books.get(market.yes);
  if (!book) return;
  const levels = side === "yes" ? book.asks : book.bids;   // NO is bought from the YES bids, mirrored
  let left = shares;
  while (left > 1e-9 && levels.length) {
    const take = Math.min(left, levels[0][1]);
    levels[0] = [levels[0][0], levels[0][1] - take];
    left -= take;
    if (levels[0][1] <= 1e-9) levels.shift();
  }
}

async function eachLimit(items, limit, work) {
  let next = 0;
  const run = async () => { while (next < items.length) { const item = items[next++]; await work(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

class AgentDesk {
  constructor({ root, ai = null, net = null, now = () => Date.now(), onEvent = () => {}, locale = () => "en", tickMs = TICK_MS, autoTick = true } = {}) {
    if (!root) throw new TypeError("root is required");
    this.root = path.resolve(root);
    this.file = path.join(this.root, "desk.json");
    this.journalFile = path.join(this.root, "journal.jsonl");
    this.ai = ai;
    this.net = net || createNet();
    this.now = now;
    this.onEvent = onEvent;
    this.locale = typeof locale === "function" ? locale : () => "en";
    this.tickMs = tickMs;
    this.autoTick = autoTick;
    this.sources = new Sources({ net: this.net, now });
    this.brain = new Brain({ ask: (query) => this.ai.agentQuery(query) });
    this.universe = [];
    this.universeAt = 0;
    this.sourceErrors = {};
    this.candidates = [];
    this.lastTickAt = null;
    this.lastTickMs = null;
    this.lastError = null;
    this.epoch = 0;
    this.active = false;
    this.disposed = false;
    this.ticking = false;
    this.timer = null;
    this.kickTimer = null;
    this.dirty = false;
    this.savedAt = 0;
    this.emittedAt = 0;
    this.error = null;
    this._load();
  }

  say(ru, en) { return this.locale() === "ru" ? ru : en; }

  // --- storage ----------------------------------------------------------------------------------------------------
  _load() {
    let stat = null;
    try { stat = fs.lstatSync(this.file); } catch (error) { if (error.code !== "ENOENT") this.error = "agents_store_corrupt"; }
    this.state = null;
    if (stat) {
      try {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw fail("agents_store_corrupt");
        this.state = validateState(JSON.parse(fs.readFileSync(this.file, "utf8")));
      } catch { this.error = "agents_store_corrupt"; }
    }
    // a damaged store is never written over: the desk shows the error and waits for a confirmed reset
    if (!this.state) this.state = initialState(DEFAULT_CONFIG, this.now());
    if (this.error) this.state.running = false;
    this.book = new PaperBook(this.state.book);
    this.tail = this._readTail();
  }

  _persist() {
    if (this.error) return;
    const data = JSON.stringify(this.state);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw fail("agents_store_too_large");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    this.dirty = false;
    this.savedAt = this.now();
  }

  _save(force = false) {
    if (!force && !this.dirty && this.now() - this.savedAt < PERSIST_MS) return;
    try { this._persist(); } catch (error) { this.lastError = codeOf(error, "agents_store_write_failed"); }
  }

  _journal(row) {
    const entry = { t: this.now(), ...row };
    this.tail.push(entry);
    if (this.tail.length > TAIL_ROWS) this.tail.splice(0, this.tail.length - TAIL_ROWS);
    if (this.error) return entry;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(this.journalFile).size; } catch { /* a new journal */ }
      if (size > JOURNAL_MAX_BYTES) fs.renameSync(this.journalFile, path.join(this.root, "journal.1.jsonl"));
      fs.appendFileSync(this.journalFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* the journal never stops the desk */ }
    return entry;
  }

  _readTail() {
    try {
      const fd = fs.openSync(this.journalFile, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, 256 * 1024);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split("\n").slice(size > length ? 1 : 0).filter(Boolean).slice(-TAIL_ROWS);
        return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(isRecord);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
  }

  _emit(force = false) {
    const now = this.now();
    if (!force && now - this.emittedAt < 2000) return;
    this.emittedAt = now;
    try { this.onEvent({ type: "agents", payload: this._brief() }); } catch { /* events never stop the desk */ }
  }

  _alert(payload) {
    try { this.onEvent({ type: "agents_alert", payload }); } catch { /* alerts never stop the desk */ }
  }

  _sourceError(name, error) { this.sourceErrors[name] = { code: codeOf(error, "agents_source_unavailable"), at: this.now() }; }

  // --- views ------------------------------------------------------------------------------------------------------
  _stats() {
    const st = this.state, b = st.book, out = {};
    for (const a of st.roster) {
      const open = b.positions.filter((p) => p.agentId === a.id);
      const unrealized = sum(open, (p) => p.shares * p.mark - p.cost - p.fees);
      const realized = b.realized[a.id] || 0;
      const c = st.counts[a.id] || { trades: 0, settled: 0, wins: 0 };
      const br = b.brier[a.id];
      out[a.id] = {
        pnl: r2(realized + unrealized), realized: r2(realized), unrealized: r2(unrealized), trades: c.trades, settled: c.settled, wins: c.wins,
        open: open.length, exposure: r2(sum(open, (p) => p.cost + p.fees)),
        brier: br && br.n ? r4(br.sum / br.n) : null, marketBrier: br && br.n ? r4(br.market / br.n) : null, brierN: br ? br.n : 0,
      };
    }
    return out;
  }

  _aiStatus() {
    const st = this.state, cfg = st.config;
    let reason = null;
    if (!cfg.aiEnabled) reason = "agents_ai_off";
    else if (cfg.aiDailyUsd <= 0) reason = "agents_ai_budget_zero";
    else {
      let answer = null;
      try { answer = this.ai && typeof this.ai.agentsAvailable === "function" ? this.ai.agentsAvailable() : null; } catch { answer = null; }
      if (!answer || answer.ok !== true) reason = (answer && answer.reason) || "ai_unavailable";
      else if (st.ai.spentUsd >= cfg.aiDailyUsd) reason = "agents_ai_budget_used";
    }
    return {
      available: !reason, reason, spentUsd: r4(st.ai.spentUsd), dailyUsd: cfg.aiDailyUsd, calls: st.ai.calls, errors: st.ai.errors,
      lastError: st.ai.lastError, lastForecastAt: st.ai.lastForecastAt || null, lastCheckAt: st.ai.lastCheckAt || null,
      forecasts: Object.keys(st.ai.forecasts).length, checks: Object.keys(st.ai.checks).length, notes: st.ai.notes.slice(-3),
    };
  }

  _brief() {
    const st = this.state, b = st.book, equity = this.book.equity();
    return {
      ok: true, mode: "paper", running: st.running, active: this.active, halt: st.halt ? { ...st.halt } : null, error: this.error,
      equity: r2(equity), cash: r2(b.cash), startCapital: b.startCapital, pnl: r2(equity - b.startCapital), pnlPct: r4((equity - b.startCapital) / b.startCapital),
      dayPnl: r2(equity - b.dayStartEquity), peakEquity: r2(b.peakEquity), drawdownPct: b.peakEquity > 0 ? r4(Math.max(0, 1 - equity / b.peakEquity)) : 0,
      exposure: r2(this.book.exposure()), openPositions: b.positions.length, trades: b.trades, feesPaid: r2(b.feesPaid),
      settled: sum(Object.values(st.counts), (c) => c.settled),
      lastTickAt: this.lastTickAt, universe: { events: this.universe.length, markets: sum(this.universe, (ev) => ev.markets.length), at: this.universeAt || null },
      ai: this._aiStatus(),
    };
  }

  _positionsView(limit) {
    return this.state.book.positions.slice().sort((a, b) => b.cost - a.cost).slice(0, limit).map((p) => ({
      id: p.id, agentId: p.agentId, type: p.type, group: p.group, eventSlug: p.eventSlug, eventTitle: p.eventTitle, sector: p.sector,
      marketId: p.marketId, label: p.label, outcome: p.outcomeLabel, shares: p.shares, entry: p.entry, cost: r2(p.cost + p.fees), fees: p.fees,
      mark: p.mark, value: r2(p.shares * p.mark), pnl: r2(p.shares * p.mark - p.cost - p.fees), prob: p.prob, openedAt: p.openedAt,
      endDate: p.endDate, mo5: p.mo5, mo60: p.mo60,
    }));
  }

  status() {
    try {
      const st = this.state, loc = this.locale() === "ru" ? "ru" : "en", stats = this._stats();
      const capital = r2((st.config.agentCapitalPct / 100) * st.config.capitalUsd);
      return {
        ...this._brief(), config: { ...st.config }, limits: LIMITS, lastError: this.lastError, lastTickMs: this.lastTickMs,
        agents: st.roster.map((a) => ({
          id: a.id, type: a.type, kind: R.TYPES[a.type].kind, label: R.TYPES[a.type][loc], about: R.TYPES[a.type].about[loc],
          status: a.status, note: a.note, params: { ...a.params }, createdAt: a.createdAt, pausedAt: a.pausedAt, capital, ...stats[a.id],
        })),
        positions: this._positionsView(200), candidates: this.candidates.slice(0, 40), journal: this.tail.slice(-60).reverse(),
        sources: { ...this.sourceErrors },
      };
    } catch (error) {
      return { ok: false, reason: codeOf(error, "agents_status_failed") };
    }
  }

  ring() {
    const st = this.state, brief = this._brief(), groups = new Map();
    for (const p of st.book.positions) {
      const g = groups.get(p.eventSlug) || { slug: p.eventSlug, title: p.eventTitle, n: 0, cost: 0, pnl: 0, agents: new Set(), rows: [] };
      g.n += 1;
      g.cost += p.cost + p.fees;
      g.pnl += p.shares * p.mark - p.cost - p.fees;
      g.agents.add(p.agentId);
      if (g.rows.length < 6) g.rows.push({ agentId: p.agentId, type: p.type, label: p.label, outcome: p.outcomeLabel, shares: p.shares, entry: p.entry, mark: p.mark });
      groups.set(p.eventSlug, g);
    }
    return {
      ok: true, at: this.now(), running: st.running, halt: st.halt ? st.halt.reason : null,
      equity: brief.equity, pnl: brief.pnl, dayPnl: brief.dayPnl, exposure: brief.exposure, open: brief.openPositions,
      events: [...groups.values()].sort((a, b) => b.cost - a.cost).slice(0, 300)
        .map((g) => ({ slug: g.slug, title: g.title, n: g.n, cost: r2(g.cost), pnl: r2(g.pnl), agents: [...g.agents], rows: g.rows })),
      candidates: this.candidates.slice(0, 30).map((c) => ({ slug: c.slug, label: c.label, type: c.type, side: c.side, edge: c.edge, verdict: c.verdict })),
    };
  }

  report({ period = "day" } = {}) {
    if (!["day", "week", "all"].includes(period)) throw fail("agents_period_invalid");
    const st = this.state, b = st.book, now = this.now(), stats = this._stats();
    const from = period === "day" ? now - DAY_MS : period === "week" ? now - 7 * DAY_MS : 0;
    const closed = b.closed.filter((p) => p.closedAt >= from);
    const opened = [...b.positions, ...b.closed].filter((p) => p.openedAt >= from);
    const tradesOf = (id) => new Set(opened.filter((p) => p.agentId === id).map((p) => p.group || p.id)).size;   // a bundle is one trade
    const agents = st.roster.map((a) => {
      const mine = closed.filter((p) => p.agentId === a.id);
      const s = stats[a.id];
      return period === "all"
        ? { id: a.id, type: a.type, status: a.status, trades: s.trades, settled: s.settled, wins: s.wins, realized: s.realized, fees: null, brier: s.brier, marketBrier: s.marketBrier, open: s.open }
        : { id: a.id, type: a.type, status: a.status, trades: tradesOf(a.id), settled: mine.length, wins: mine.filter((p) => p.pnl > 0).length,
          realized: r2(sum(mine, (p) => p.pnl)), fees: r2(sum(opened.filter((p) => p.agentId === a.id), (p) => p.fees)), brier: s.brier, marketBrier: s.marketBrier, open: s.open };
    });
    const totals = {
      trades: sum(agents, (a) => a.trades), settled: sum(agents, (a) => a.settled), wins: sum(agents, (a) => a.wins),
      realized: r2(sum(agents, (a) => a.realized)), fees: period === "all" ? r2(b.feesPaid) : r2(sum(agents, (a) => a.fees || 0)),
    };
    const equity = this.book.equity();
    return {
      ok: true, period, from, to: now, equity: r2(equity), startCapital: b.startCapital, pnl: r2(equity - b.startCapital), totals, agents,
      ai: { calls: st.ai.calls, spentUsd: r4(st.ai.spentUsd) }, halt: st.halt ? { ...st.halt } : null,
      closed: closed.slice(-50).reverse().map((p) => ({ agentId: p.agentId, type: p.type, eventSlug: p.eventSlug, label: p.label, outcome: p.outcomeLabel,
        cost: r2(p.cost + p.fees), payout: p.payout, pnl: p.pnl, result: p.result, openedAt: p.openedAt, closedAt: p.closedAt })),
    };
  }

  // --- commands ---------------------------------------------------------------------------------------------------
  _guard() {
    if (this.disposed) throw fail("agents_disposed");
    if (this.error) throw fail(this.error);
  }

  configure(patch = {}) {
    this._guard();
    const st = this.state;
    const next = validateConfig(patch, st.config);
    if (next.capitalUsd !== st.config.capitalUsd) {
      if (st.book.trades > 0 || st.book.positions.length) throw fail("agents_reset_required");
      st.book = freshBook(next.capitalUsd, this.now());
      this.book = new PaperBook(st.book);
    }
    const changed = Object.keys(next).filter((key) => next[key] !== st.config[key]);
    st.config = next;
    if (changed.length) this._journal({ kind: "config", changed });
    this._save(true);
    this._emit(true);
    return this.status();
  }

  start({ by } = {}) {
    this._guard();
    const st = this.state;
    if (st.config.mode !== "paper") throw fail("agents_live_requires_certificate");
    if (st.halt) throw fail("agents_halted");
    if (!st.running) {
      st.running = true;
      this._journal({ kind: "start", by: who(by) });
      this._save(true);
      this._kick();
    }
    this._emit(true);
    return this.status();
  }

  stop({ by } = {}) {
    this._guard();
    const st = this.state;
    if (st.running) {
      st.running = false;
      this._journal({ kind: "stop", by: who(by) });
      this._save(true);
    }
    this._emit(true);
    return this.status();
  }

  // Emergency stop: no new trades until someone clears it. Open paper positions are still marked and settled.
  kill({ by } = {}) {
    this._guard();
    const st = this.state;
    st.running = false;
    if (!st.halt) {
      st.halt = { reason: "manual", at: this.now(), by: who(by) };
      this._journal({ kind: "halt", reason: "manual", by: who(by) });
      this._alert({ kind: "halt", halt: { ...st.halt } });
    }
    this._save(true);
    this._emit(true);
    return this.status();
  }

  // Clears a halt and starts. A manual halt clears from the app or Telegram; the automatic stops only from the app,
  // which also takes the current equity as the new day's start (daily loss) or the new peak (drawdown).
  resume({ by } = {}) {
    this._guard();
    const st = this.state, from = who(by);
    if (st.halt) {
      if (from === "telegram" && st.halt.reason !== "manual") throw fail("agents_halt_desktop_only");
      const equity = this.book.equity();
      if (st.halt.reason === "drawdown") st.book.peakEquity = equity;
      if (st.halt.reason === "daily_loss") st.book.dayStartEquity = equity;
      this._journal({ kind: "halt_clear", reason: st.halt.reason, by: from });
      st.halt = null;
    }
    if (!st.running) {
      st.running = true;
      this._journal({ kind: "start", by: from });
    }
    this._save(true);
    this._kick();
    this._emit(true);
    return this.status();
  }

  agent({ id, action } = {}) {
    this._guard();
    const st = this.state, agent = st.roster.find((a) => a.id === id);
    if (!agent) throw fail("agents_agent_not_found");
    if (action === "pause") {
      if (agent.status !== "active") throw fail("agents_agent_not_active");
      Object.assign(agent, { status: "paused", pausedAt: this.now(), note: "manual" });
    } else if (action === "resume") {
      if (agent.status !== "paused") throw fail("agents_agent_not_paused");
      Object.assign(agent, { status: "active", pausedAt: null, note: "manual" });
    } else throw fail("agents_action_invalid");
    this._journal({ kind: "roster", op: action, agentId: agent.id, type: agent.type, reason: "manual", by: "ui" });
    this._save(true);
    this._emit(true);
    return this.status();
  }

  // A fresh paper book and roster. A damaged store is moved aside first (never deleted).
  reset({ capitalUsd, confirm } = {}) {
    if (this.disposed) throw fail("agents_disposed");
    if (confirm !== true) throw fail("agents_confirmation_required");
    const base = this.error ? DEFAULT_CONFIG : this.state.config;
    const config = validateConfig(capitalUsd == null ? {} : { capitalUsd }, base);
    if (this.error) {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`); }
      catch (error) { if (error.code !== "ENOENT") throw fail("agents_store_unwritable"); }
      this.error = null;
    }
    this.epoch += 1;
    this.state = initialState(config, this.now());
    this.book = new PaperBook(this.state.book);
    this.candidates = [];
    this._journal({ kind: "reset", capitalUsd: config.capitalUsd });
    this._save(true);
    this._emit(true);
    return this.status();
  }

  setContext({ active = false } = {}) {
    if (this.disposed) return false;
    const next = Boolean(active);
    if (next === this.active) return next;
    this.active = next;
    if (next && this.autoTick) {
      this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
      this.timer.unref?.();
      this._kick(3000);
    } else if (!next) {
      clearInterval(this.timer);
      clearTimeout(this.kickTimer);
      this.timer = null;
      this.kickTimer = null;
      this._save();
    }
    this._emit(true);
    return next;
  }

  _kick(delay = 1000) {
    if (!this.active || !this.autoTick || this.disposed) return;
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => { this.kickTimer = null; this.tick().catch(() => {}); }, delay);
    this.kickTimer.unref?.();
  }

  // Paper only: the desk never holds anything at a venue, so it never blocks a handoff.
  idle() { return true; }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
    if (!this.disposed) this._save();
    this.active = false;
    this.disposed = true;
    this.epoch += 1;
  }

  // --- the minute -------------------------------------------------------------------------------------------------
  async tick() {
    if (this.disposed || this.error || this.ticking) return false;
    this.ticking = true;
    const epoch = this.epoch, started = this.now();
    try {
      await this._tick(epoch);
      if (this._current(epoch)) this.lastError = null;
    } catch (error) {
      this.lastError = codeOf(error, "agents_tick_failed");
    } finally {
      this.ticking = false;
      this.lastTickAt = this.now();
      this.lastTickMs = this.lastTickAt - started;
    }
    return true;
  }

  _current(epoch) { return epoch === this.epoch && !this.disposed; }

  async _tick(epoch) {
    const st = this.state;
    let now = this.now();
    this._dayRoll(now);
    const working = st.running && !st.halt;
    const holding = st.book.positions.length > 0;
    if (!working && !holding) {
      this.candidates = [];
      this._notify(now);
      this._save();
      return;
    }
    if (working && now - this.universeAt >= st.config.refreshMin * 60000) await this._refresh(now);
    if (!this._current(epoch)) return;
    const candidates = working ? await this._screen(now) : [];
    if (!this._current(epoch)) return;
    const books = await this._books(candidates, working, now);
    if (!this._current(epoch)) return;
    let resolutions = null;
    if (holding && now - st.lastSettleAt >= SETTLE_MS) {
      try {
        resolutions = await MK.fetchResolutions(this.net, st.book.positions.map((p) => p.conditionId));
        delete this.sourceErrors.gamma_resolutions;
      } catch (error) { this._sourceError("gamma_resolutions", error); }
    }
    if (!this._current(epoch)) return;
    now = this.now();
    this._marks(books, now);
    if (resolutions) {
      st.lastSettleAt = now;
      this._settle(resolutions, now);
    }
    this._halt(now);
    if (st.running && !st.halt) {
      this._execute(candidates, books, now);
      this._maker(books, now);
    } else this.candidates = [];
    if (now - st.lastRosterAt >= ROSTER_MS) this._roster(now);
    this._notify(now);
    this._save();
    this._emit(true);
    if (st.running && !st.halt) await this._ai(now, epoch);
  }

  _dayRoll(now) {
    const st = this.state, day = dayKey(now);
    if (st.ai.day !== day) Object.assign(st.ai, { day, spentUsd: 0, calls: 0 });
    if (st.book.day === day) return;
    st.book.day = day;
    st.book.dayStartEquity = this.book.equity();
    if (st.halt && st.halt.reason === "daily_loss") {
      this._journal({ kind: "halt_clear", reason: "daily_loss", by: "new_day" });
      st.halt = null;
    }
    this.dirty = true;
  }

  async _refresh(now) {
    const cfg = this.state.config, at = (t) => new Date(t).toISOString();
    const window = (from, to) => `end_date_min=${at(from)}&end_date_max=${at(to)}&order=volume24hr&ascending=false`;
    const jobs = [
      ["gamma_top", () => MK.fetchTopEvents(this.net, { pages: Math.max(1, Math.round(cfg.topEvents / 100)) })],
      ["gamma_soon", () => MK.fetchEvents(this.net, `closed=false&${window(now, now + 7 * DAY_MS)}`, { pages: 2 })],
      ["gamma_weather", () => MK.fetchEvents(this.net, `closed=false&tag_slug=daily-temperature&${window(now - DAY_MS, now + 3 * DAY_MS)}`, { pages: 2 })],
      ["gamma_bitcoin", () => MK.fetchEvents(this.net, `closed=false&tag_slug=bitcoin&${window(now, now + 35 * DAY_MS)}`)],
      ["gamma_ethereum", () => MK.fetchEvents(this.net, `closed=false&tag_slug=ethereum&${window(now, now + 35 * DAY_MS)}`)],
    ];
    const held = [...new Set(this.state.book.positions.map((p) => p.eventId))];
    if (held.length) jobs.push(["gamma_held", () => MK.fetchEventsById(this.net, held)]);
    const byId = new Map();
    let ok = 0;
    for (const [name, job] of jobs) {
      try {
        for (const ev of await job()) if (ev.id) byId.set(ev.id, ev);
        ok += 1;
        delete this.sourceErrors[name];
      } catch (error) { this._sourceError(name, error); }
    }
    if (ok) {
      this.universe = [...byId.values()];
      this.universeAt = now;
    } else this.universeAt = now - cfg.refreshMin * 60000 + 120000;   // nothing came back: try again in two minutes
  }

  async _screen(now) {
    const st = this.state, cfg = st.config, U = this.universe;
    for (const [key, until] of Object.entries(st.seen)) if (until <= now) delete st.seen[key];
    if (!U.length) return [];
    const minEdge = cfg.minEdgePct / 100;
    const active = st.roster.filter((a) => a.status === "active");
    const of = (type) => active.filter((a) => a.type === type);
    const out = [];
    const add = (agent, list) => { for (const c of list) out.push({ ...c, agentId: agent.id, ckey: `${agent.id}:${c.key}` }); };
    for (const a of of("arb_bundle")) add(a, SC.screenBundles(U, cfg));
    for (const a of of("arb_ladder")) add(a, SC.screenLadders(U, cfg));
    for (const a of of("favorites")) add(a, SC.screenFavorites(U, { ...R.DEFAULT_PARAMS.favorites, ...a.params }, now));
    if (of("crypto_levels").length) {
      const list = await this._cryptoCandidates(U, now, minEdge);
      for (const a of of("crypto_levels")) add(a, list);
    }
    const weather = of("weather");
    if (weather.length) {
      const lead = (a) => (num(a.params.maxLeadDays) ? a.params.maxLeadDays : R.DEFAULT_PARAMS.weather.maxLeadDays);
      const models = await this._weatherModels(U, now, Math.max(...weather.map(lead)));
      for (const a of weather) add(a, SC.screenWeather(models.filter((m) => m.lead <= lead(a)), minEdge));
    }
    for (const a of of("forecast")) add(a, this._forecastCandidates(U, now, minEdge, { ...R.DEFAULT_PARAMS.forecast, ...a.params }));
    for (const a of of("resolution")) add(a, this._checkCandidates(U, now, minEdge));
    return out.filter((c) => !(st.seen[c.ckey] > now));
  }

  async _cryptoCandidates(U, now, minEdge) {
    const events = U.filter((ev) => M.parseCryptoEvent(ev.title));
    if (!events.length) return [];
    const data = {};
    for (const asset of [...new Set(events.map((ev) => M.parseCryptoEvent(ev.title).asset))]) {
      try {
        // the volatility index is context for the journal only: the screen prices with the ladders' own σ
        const [spot, vol] = await Promise.all([this.sources.spot(asset), this.sources.vol(asset).catch((error) => { this._sourceError(`vol_${asset}`, error); return null; })]);
        data[asset] = { spot: spot.price, source: spot.source, sigma: vol ? vol.sigma : null, volSource: vol ? vol.source : null, extremes: {} };
        delete this.sourceErrors[`crypto_${asset}`];
        if (vol) delete this.sourceErrors[`vol_${asset}`];
      } catch (error) { this._sourceError(`crypto_${asset}`, error); }
    }
    for (const ev of events) {
      const info = M.parseCryptoEvent(ev.title);
      if (info.kind !== "touch" || !data[info.asset]) continue;
      try { data[info.asset].extremes[ev.id] = await this.sources.extremes(info.asset, ev.startDate || now - 30 * DAY_MS); } catch { /* the touch markets of this event are skipped */ }
    }
    return SC.screenCrypto(events, data, now, minEdge);
  }

  async _weatherModels(U, now, maxLead) {
    const today = Date.parse(`${dayKey(now)}T00:00:00Z`);
    const rows = [];
    for (const ev of U) {
      if (!/temperature/i.test(ev.title)) continue;
      const info = M.parseWeatherEvent(ev);
      if (!info) continue;
      const lead = Math.round((Date.parse(`${info.date}T00:00:00Z`) - today) / DAY_MS);
      if (lead >= -1 && lead <= maxLead) rows.push({ ev, info, lead });   // −1: west of UTC the local day may still run
    }
    if (!rows.length) return [];
    const icaos = [...new Set(rows.map((x) => x.info.icao))];
    let stations, metars;
    try {
      stations = await this.sources.stations(icaos);
      metars = await this.sources.metars(icaos);
      delete this.sourceErrors.metar;
    } catch (error) { this._sourceError("metar", error); return []; }
    const models = [];
    await eachLimit(rows, 4, async ({ ev, info, lead }) => {
      const station = stations.get(info.icao);
      if (!station) return;
      let ens;
      try { ens = await this.sources.ensemble(info.icao, station); delete this.sourceErrors.ensemble; } catch (error) { this._sourceError("ensemble", error); return; }
      const obs = metars.get(info.icao) || [];
      const dayStart = Date.parse(`${info.date}T00:00:00Z`) - ens.offsetSec * 1000;
      if (now > dayStart + 3600000 && !obs.some((o) => o.t <= dayStart + 90 * 60000)) return;   // the day's first reports are missing: no extreme to trust
      const result = M.weatherProbabilities({ kind: info.kind, date: info.date, unit: info.unit, buckets: info.buckets, times: ens.times,
        members: ens.members, offsetSec: ens.offsetSec, obs, now });
      if (!result) return;
      if (!result.remainingHours) {   // the day is over: trust the observed extreme only from a full day of reports
        const local = (t) => new Date(t + ens.offsetSec * 1000).toISOString().slice(0, 10);
        if (obs.filter((o) => local(o.t) === info.date).length < 20) return;
      }
      models.push({ event: ev, result, info, lead });
    });
    return models;
  }

  _forecastCandidates(U, now, minEdge, params) {
    const out = [], cache = this.state.ai.forecasts;
    if (!Object.keys(cache).length) return out;
    for (const ev of U) for (const m of ev.markets) {
      const f = cache[m.id];
      if (!f || now - f.at > FORECAST_TTL_MS || !m.accepting || m.closed || !(m.bid > 0) || !(m.ask > 0)) continue;
      const end = m.endDate || ev.endDate;
      if (!end || end < now + DAY_MS || end > now + params.maxDays * DAY_MS) continue;
      const w = SHRINK[f.confidence] || SHRINK.low;
      const mid = (m.bid + m.ask) / 2;
      const q = SC.quoteEdge(m, mid + w * (f.p - mid));
      if (q.edge < 0.5 * minEdge) continue;
      out.push({ key: `fc:${m.id}:${q.side}`, type: "forecast", event: ev, market: m, side: q.side, prob: q.prob, hint: q.edge, shrink: { p: f.p, w },
        model: `AI p=${f.p.toFixed(2)} (${f.confidence}) → ${(mid + w * (f.p - mid)).toFixed(3)}: ${f.reason}` });
    }
    return out.sort((a, b) => b.hint - a.hint).slice(0, 10);
  }

  _checkCandidates(U, now, minEdge) {
    const out = [], cache = this.state.ai.checks;
    for (const ev of U) for (const m of ev.markets) {
      const c = cache[m.id];
      if (!c || (c.status !== "decided_yes" && c.status !== "decided_no") || now - c.at > CHECK_TTL_MS) continue;
      if (!m.accepting || m.closed || !(m.bid > 0) || !(m.ask > 0)) continue;
      const target = c.status === "decided_yes" ? DECIDED.p : 1 - DECIDED.p;
      const mid = (m.bid + m.ask) / 2;
      const q = SC.quoteEdge(m, mid + DECIDED.w * (target - mid));
      if (q.edge < 0.5 * minEdge || q.side !== (c.status === "decided_yes" ? "yes" : "no")) continue;
      out.push({ key: `rs:${m.id}:${q.side}`, type: "resolution", event: ev, market: m, side: q.side, prob: q.prob, hint: q.edge,
        shrink: { p: target, w: DECIDED.w }, model: `AI ${c.status}: ${c.evidence || ""}`.slice(0, 220) });
    }
    return out.sort((a, b) => b.hint - a.hint).slice(0, 10);
  }

  _makerAgent() { return this.state.roster.find((a) => a.type === "maker" && a.status === "active") || null; }

  async _books(candidates, working, now) {
    const tokens = this.state.book.positions.map((p) => p.tokenId);
    for (const c of candidates) {
      if (c.legs) for (const leg of c.legs) tokens.push(leg.market.yes);
      else tokens.push(c.market.yes);
    }
    if (working && this._makerAgent()) for (const x of SC.makerPool(this.universe, now, 4)) tokens.push(x.market.yes);
    const unique = [...new Set(tokens)].slice(0, MAX_BOOK_TOKENS);
    if (!unique.length) return new Map();
    try {
      const books = await MK.fetchBooks(this.net, unique, now);
      delete this.sourceErrors.clob_books;
      return books;
    } catch (error) {
      this._sourceError("clob_books", error);
      return new Map();
    }
  }

  _marks(books, now) {
    const positions = this.state.book.positions;
    for (const token of new Set(positions.map((p) => p.tokenId))) {
      const b = books.get(token);
      if (b) this.book.mark(token, b.bids[0]?.[0] ?? null, b.asks[0]?.[0] ?? null, now);
    }
    // markouts: where the price stood 5 and 60 minutes after the entry (per share, + is in our favour)
    for (const p of positions) {
      if (p.mo5 == null && p.markAt - p.openedAt >= 5 * 60000) p.mo5 = r4(p.mark - p.entry);
      if (p.mo60 == null && p.markAt - p.openedAt >= 60 * 60000) p.mo60 = r4(p.mark - p.entry);
    }
  }

  _settle(resolutions, now) {
    const st = this.state;
    for (const [cid, r] of resolutions) {
      if (r.status && /propos|disput|challeng/i.test(r.status)) continue;   // wait for the final word
      for (const row of this.book.settle(cid, r.prices, now)) {
        const c = st.counts[row.agentId] || (st.counts[row.agentId] = { trades: 0, settled: 0, wins: 0 });
        c.settled += 1;
        if (row.pnl > 0) c.wins += 1;
        const entry = { kind: "settle", agentId: row.agentId, type: row.type, eventSlug: row.eventSlug, label: row.label, outcome: row.outcomeLabel,
          result: row.result, shares: row.shares, costUsd: r2(row.cost + row.fees), payout: row.payout, pnl: row.pnl, positionId: row.id, group: row.group };
        this._journal(entry);
        this._digest(entry);
        this.dirty = true;
      }
    }
    if (this.dirty) {
      const live = new Set(st.book.positions.map((p) => p.marketId));
      for (const key of Object.keys(st.maker)) if (!live.has(key) && !this.universe.some((ev) => ev.markets.some((m) => m.id === key && !m.closed))) delete st.maker[key];
    }
  }

  _halt(now) {
    const st = this.state, equity = this.book.equity();
    if (equity > st.book.peakEquity) st.book.peakEquity = r6(equity);
    if (st.halt) return;
    const h = haltCheck({ config: st.config, equity, dayStartEquity: st.book.dayStartEquity, peakEquity: st.book.peakEquity });
    if (!h) return;
    st.halt = { reason: h.reason, at: now, by: "rules", equity: r2(h.equity), limit: r2(h.limit) };
    this._journal({ kind: "halt", reason: h.reason, equity: r2(h.equity), limit: r2(h.limit), by: "rules" });
    this._alert({ kind: "halt", halt: { ...st.halt } });
    this.dirty = true;
  }

  // The YES mid on the fresh book, else on Gamma's quotes.
  _mid(c, books) {
    const book = books.get(c.market.yes);
    const bid = book?.bids[0]?.[0], ask = book?.asks[0]?.[0];
    return bid != null && ask != null ? (bid + ask) / 2 : (c.market.bid + c.market.ask) / 2;
  }

  _prob(c, books, agent) {
    if (c.type === "favorites") {
      const bias = num(agent.params.bias) ? agent.params.bias : R.DEFAULT_PARAMS.favorites.bias;
      return (price) => Math.min(0.995, price + bias);
    }
    if (c.shrink) {
      const mid = this._mid(c, books);
      const yes = mid + c.shrink.w * (c.shrink.p - mid);
      return c.side === "yes" ? yes : 1 - yes;
    }
    return c.prob;
  }

  // Reasons a single-market candidate is refused before its book is sized: too many markets of its match already,
  // or (weather) a model too far from the fresh mid.
  _precheck(c, agent, books, say) {
    if (matchCount(this.book, agent.id, c.event, c.market.id) >= MAX_PER_MATCH) {
      return say(`у агента уже ${MAX_PER_MATCH} рынка этого матча`, `the agent already holds ${MAX_PER_MATCH} markets of this match`);
    }
    if (c.shrink && num(c.shrink.maxGap)) {
      const mid = this._mid(c, books);
      if (Number.isFinite(mid) && Math.abs(c.shrink.p - mid) > c.shrink.maxGap) {
        const pc = (x) => `${(x * 100).toFixed(0)}%`;
        return say(`модель ${pc(c.shrink.p)} против рынка ${pc(mid)}: расхождение больше ${pc(c.shrink.maxGap)}, вероятнее ошибка модели`,
          `model ${pc(c.shrink.p)} vs the market ${pc(mid)}: a gap over ${pc(c.shrink.maxGap)} is likelier a model error`);
      }
    }
    return null;
  }

  _execute(candidates, books, now) {
    const st = this.state, cfg = st.config, say = (ru, en) => this.say(ru, en);
    const minEdge = cfg.minEdgePct / 100;
    const bankroll = (cfg.agentCapitalPct / 100) * cfg.capitalUsd;
    const isArb = (c) => c.type === "arb_bundle" || c.type === "arb_ladder";
    const rank = (c) => (isArb(c) ? 3 + c.hint : c.type === "favorites" ? 1 : 2 + c.hint);
    const order = candidates.map((c, i) => ({ c, i })).sort((a, b) => rank(b.c) - rank(a.c) || a.i - b.i).map((x) => x.c);
    const views = [];
    let trades = 0;
    for (const c of order) {
      const view = { agentId: c.agentId, type: c.type, slug: c.event.slug, title: c.event.title.slice(0, 120), label: c.label || c.market?.label || "",
        side: c.side || null, hint: r4(c.hint > 1 ? 0 : c.hint), edge: null, verdict: "queued", why: null, model: c.model ? String(c.model).slice(0, 220) : null };
      views.push(view);
      if (trades >= MAX_TRADES_PER_TICK) continue;
      const agent = st.roster.find((a) => a.id === c.agentId);
      if (!agent || agent.status !== "active") { view.verdict = "skipped"; continue; }
      const arbitrage = isArb(c);
      const cap = capacity({ config: cfg, book: this.book, equity: this.book.equity(), agentId: agent.id, event: c.event, market: arbitrage ? null : c.market, arbitrage });
      let res;
      const refused = arbitrage ? null : this._precheck(c, agent, books, say);
      if (cap.usd < 1) res = { skip: say(`лимит «${limitName(cap.binding)}» исчерпан`, `limit "${limitName(cap.binding, true)}" used up`) };
      else if (arbitrage) res = SC.confirmArbitrage(c, books, cfg, cap, say);
      else if (refused) res = { skip: refused };
      else {
        res = SC.confirmSingle(c, books, { cap, prob: this._prob(c, books, agent), fraction: cfg.kellyFraction, bankroll, say,
          minEdge: c.type === "favorites" ? (num(agent.params.minEdge) ? agent.params.minEdge : R.DEFAULT_PARAMS.favorites.minEdge) : minEdge });
      }
      if (res && res.orders && res.orders.length + st.book.positions.length > MAX_OPEN) res = { skip: say("слишком много открытых позиций", "too many open positions") };
      if (res && res.orders && res.costUsd > st.book.cash + 1e-9) res = { skip: say("не хватает кэша", "not enough cash") };
      if (!res || !res.orders) {
        view.verdict = "skipped";
        view.why = res?.skip || null;
        view.edge = res?.edge != null ? r4(res.edge) : null;
        if (!arbitrage) st.seen[c.ckey] = now + COOLDOWN_MS.skip;
        continue;
      }
      const group = res.orders.length > 1 ? `g${++st.groupSeq}` : null;
      const opened = res.orders.map((o) => {
        const position = this.book.open({ agentId: agent.id, type: c.type, src: c.key, event: c.event, market: o.market, side: o.side, fill: o.fill,
          prob: arbitrage ? null : res.prob, marketProb: arbitrage ? null : res.marketProb ?? null, group, now });
        consume(books, o.market, o.side, o.fill.shares);
        return position;
      });
      st.seen[c.ckey] = now + (arbitrage ? COOLDOWN_MS.arb : COOLDOWN_MS.single);
      const counts = st.counts[agent.id] || (st.counts[agent.id] = { trades: 0, settled: 0, wins: 0 });
      counts.trades += 1;
      const first = res.orders[0];
      const entry = {
        kind: "trade", agentId: agent.id, type: c.type, eventSlug: c.event.slug, eventTitle: c.event.title.slice(0, 120),
        label: res.orders.length > 1 ? c.label : first.market.label, outcome: res.orders.length > 1 ? c.label : first.market.outcomes[first.side === "yes" ? 0 : 1],
        legs: res.orders.length, shares: first.fill.shares, avg: res.orders.length === 1 ? r4(first.fill.avg) : null, costUsd: r2(res.costUsd),
        edge: r4(res.edge), prob: res.prob == null ? null : r4(res.prob), binding: cap.binding, why: res.why, model: view.model, group,
        positions: opened.map((p) => p.id),
      };
      this._journal(entry);
      this._digest(entry);
      Object.assign(view, { verdict: "traded", why: res.why, edge: r4(res.edge) });
      trades += 1;
      this.dirty = true;
    }
    const seen = Object.keys(st.seen);
    if (seen.length > 2000) for (const key of seen.slice(0, seen.length - 2000)) delete st.seen[key];
    this.candidates = views.slice(0, 60);
  }

  // The shadow maker: virtual quotes at the best bid of YES and of NO on reward markets; a fill counts only when the
  // book trades through a quote (see scanners.makerStep). Fills pay no fee; rewards are not counted.
  _maker(books, now) {
    const st = this.state, cfg = st.config, agent = this._makerAgent();
    const pool = agent ? SC.makerPool(this.universe, now, 4) : [];
    const keep = new Set(pool.map((x) => x.market.id));
    for (const key of Object.keys(st.maker)) if (!keep.has(key)) delete st.maker[key];
    for (const { event, market } of pool) {
      const book = books.get(market.yes);
      if (!book || !book.bids.length || !book.asks.length) { delete st.maker[market.id]; continue; }
      const mine = st.book.positions.filter((p) => p.agentId === agent.id && p.marketId === market.id);
      const inventory = { yes: sum(mine.filter((p) => p.outcome === 0), (p) => p.shares), no: sum(mine.filter((p) => p.outcome === 1), (p) => p.shares) };
      const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
      const size = Math.max(market.rewards?.minSize || 0, book.minSize || 5);
      const maxShares = Math.floor(cfg.perMarketUsd / 2 / Math.max(0.05, mid, 1 - mid));
      const { fills, quote } = SC.makerStep(st.maker[market.id] || null, book, market, { size, maxShares, inventory, now });
      for (const f of fills) {
        const fill = { shares: f.shares, cost: r6(f.shares * f.price), fees: 0, avg: f.price, worst: f.price };
        const cap = capacity({ config: cfg, book: this.book, equity: this.book.equity(), agentId: agent.id, event, market });
        if (fill.cost > cap.usd || fill.cost > st.book.cash || st.book.positions.length >= MAX_OPEN) continue;
        const position = this.book.open({ agentId: agent.id, type: "maker", src: `mk:${market.id}`, event, market, side: f.side, fill, now });
        const counts = st.counts[agent.id] || (st.counts[agent.id] = { trades: 0, settled: 0, wins: 0 });
        counts.trades += 1;
        const entry = { kind: "trade", agentId: agent.id, type: "maker", eventSlug: event.slug, eventTitle: event.title.slice(0, 120), label: market.label,
          outcome: market.outcomes[f.side === "yes" ? 0 : 1], legs: 1, shares: f.shares, avg: f.price, costUsd: r2(fill.cost), edge: null, prob: null,
          binding: cap.binding, why: this.say(`заявка ${f.price} пробита: ${f.shares} ш без комиссии`, `quote ${f.price} traded through: ${f.shares} sh, no fee`),
          group: null, positions: [position.id] };
        this._journal(entry);
        this._digest(entry);
        this.dirty = true;
      }
      st.maker[market.id] = quote;
    }
  }

  _roster(now) {
    const st = this.state;
    st.lastRosterAt = now;
    for (const action of R.evaluateRoster(st.roster, this._stats(), st.config, now)) this._applyRoster(action, now, "rules");
  }

  _applyRoster(action, now, by) {
    const st = this.state, agent = R.applyRoster(st.roster, action, now);
    if (!agent) return null;
    this._journal({ kind: "roster", op: action.op, agentId: agent.id, type: agent.type, reason: action.reason, by });
    this._alert({ kind: "roster", op: action.op, agentId: agent.id, type: agent.type, reason: action.reason });
    const retired = st.roster.filter((a) => a.status === "retired");
    if (st.roster.length > 32 && retired.length) st.roster = st.roster.filter((a) => a !== retired[0]);   // the oldest retired leaves the list
    this.dirty = true;
    return agent;
  }

  _digest(entry) {
    const cfg = this.state.config, n = this.state.notify;
    if (!cfg.notifyTrades) return;
    const row = { kind: entry.kind, agentId: entry.agentId, type: entry.type, label: String(entry.label || "").slice(0, 80), outcome: String(entry.outcome || "").slice(0, 40),
      legs: entry.legs || 1, costUsd: entry.costUsd, avg: entry.avg ?? null, edge: entry.edge ?? null, pnl: entry.pnl ?? null, t: this.now() };
    if (cfg.digestMin === 0) return this._alert({ kind: "trade", row });
    n.digest.push(row);
    n.count += 1;
    if (n.digest.length > 40) n.digest.splice(0, n.digest.length - 40);
  }

  _notify(now) {
    const st = this.state, cfg = st.config, n = st.notify;
    if (!cfg.notifyTrades) { n.digest = []; n.count = 0; }
    if (cfg.digestMin > 0 && now - n.lastDigestAt >= cfg.digestMin * 60000) {
      if (n.digest.length) this._alert({ kind: "digest", minutes: cfg.digestMin, rows: n.digest.slice(), count: n.count, summary: this._brief() });
      n.digest = [];
      n.count = 0;
      n.lastDigestAt = now;
      this.dirty = true;
    }
    const day = dayKey(now);
    if (n.lastReportDay !== day && new Date(now).getUTCHours() >= cfg.reportHourUtc) {
      n.lastReportDay = day;
      const report = this.report({ period: "day" });
      if (st.running || st.book.positions.length || report.totals.trades || report.totals.settled) this._alert({ kind: "daily", report });
      this.dirty = true;
    }
  }

  // --- the language model -----------------------------------------------------------------------------------------
  async _ai(now, epoch) {
    const st = this.state, cfg = st.config;
    if (!this._aiStatus().available || !this.ai || typeof this.ai.agentQuery !== "function") return;
    const active = (type) => st.roster.filter((a) => a.type === type && a.status === "active");
    try {
      if (active("resolution").length && now - st.ai.lastCheckAt >= CHECK_MS) return await this._aiChecks(now, epoch);
      const forecasters = active("forecast");
      if (forecasters.length && now - st.ai.lastForecastAt >= cfg.aiEveryMin * 60000) return await this._aiForecasts(now, epoch, forecasters);
      if (sum(Object.values(st.counts), (c) => c.settled) >= 10 && now - st.ai.lastPlanAt >= PLAN_MS) return await this._aiPlan(now, epoch);
    } catch (error) {
      if (!this._current(epoch)) return;
      st.ai.errors += 1;
      st.ai.lastError = codeOf(error, "agents_ai_failed");
      this._journal({ kind: "ai_error", code: st.ai.lastError });
      this.dirty = true;
      this._save();
    }
  }

  _aiSpent(out) {
    const ai = this.state.ai;
    if (!out.asked) return;
    ai.spentUsd = r6(ai.spentUsd + (out.costUsd || 0));
    ai.calls += 1;
    ai.lastError = null;
  }

  _prune(cache, limit) {
    const keys = Object.keys(cache);
    if (keys.length <= limit) return;
    for (const key of keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - limit)) delete cache[key];
  }

  async _headlines(question, days) {
    try {
      const rows = await this.sources.headlines(question, { days, limit: 4 });
      delete this.sourceErrors.news;
      return rows;
    } catch (error) {
      this._sourceError("news", error);
      return [];
    }
  }

  async _aiChecks(now, epoch) {
    const st = this.state;
    st.ai.lastCheckAt = now;
    this.dirty = true;
    const pool = SC.resolutionPool(this.universe, now, (id) => st.ai.checks[id], { limit: 5 });
    const items = [];
    for (const x of pool) {
      const question = x.market.question || x.event.title;
      const headlines = await this._headlines(question, 3);
      if (!this._current(epoch)) return;
      if (headlines.length) items.push({ id: x.market.id, question, rules: x.event.description, endDate: x.market.endDate || x.event.endDate, lean: x.lean, price: x.mid, headlines });
      else st.ai.checks[x.market.id] = { status: "undecided", evidence: null, reason: "", at: now, model: null };   // no news, no question
    }
    if (!items.length) return;
    const out = await this.brain.resolution(items, now);
    if (!this._current(epoch)) return;
    this._aiSpent(out);
    for (const it of items) st.ai.checks[it.id] = { status: "undecided", evidence: null, reason: "", at: now, model: out.model };
    for (const row of out.rows) st.ai.checks[row.id] = { status: row.status, evidence: row.evidence, reason: row.reason, at: now, model: out.model };
    this._prune(st.ai.checks, 200);
    this._journal({ kind: "ai", task: "resolution", asked: out.asked || 0, answered: out.rows.length,
      decided: out.rows.filter((r) => r.status !== "undecided").map((r) => ({ id: r.id, status: r.status, evidence: r.evidence })), costUsd: r6(out.costUsd), model: out.model });
    this._save();
  }

  async _aiForecasts(now, epoch, agents) {
    const st = this.state;
    st.ai.lastForecastAt = now;
    this.dirty = true;
    const params = agents.map((a) => ({ ...R.DEFAULT_PARAMS.forecast, ...a.params }));
    const pool = SC.forecastPool(this.universe, now, (id) => st.ai.forecasts[id],
      { minDays: Math.min(...params.map((p) => p.minDays)), maxDays: Math.max(...params.map((p) => p.maxDays)), limit: 5 });
    if (!pool.length) return;
    const items = [];
    for (const x of pool) {
      const question = x.market.question || x.event.title;
      items.push({ id: x.market.id, question, rules: x.event.description, endDate: x.market.endDate || x.event.endDate, mid: x.mid, headlines: await this._headlines(question, 7) });
      if (!this._current(epoch)) return;
    }
    const out = await this.brain.forecast(items, now);
    if (!this._current(epoch)) return;
    this._aiSpent(out);
    const mids = new Map(pool.map((x) => [x.market.id, x.mid]));
    for (const row of out.rows) st.ai.forecasts[row.id] = { p: row.p, confidence: row.confidence, reason: row.reason, at: now, mid: mids.get(row.id), model: out.model };
    this._prune(st.ai.forecasts, 200);
    this._journal({ kind: "ai", task: "forecast", asked: out.asked || 0, answered: out.rows.length,
      rows: out.rows.map((r) => ({ id: r.id, p: r.p, confidence: r.confidence, mid: mids.get(r.id) })), costUsd: r6(out.costUsd), model: out.model });
    this._save();
  }

  async _aiPlan(now, epoch) {
    const st = this.state;
    st.ai.lastPlanAt = now;
    this.dirty = true;
    const stats = this._stats();
    const summary = { equity: this.book.equity(), capital: st.config.capitalUsd, variants: Object.keys(R.VARIANTS),
      agents: st.roster.filter((a) => a.status !== "retired").map((a) => ({ id: a.id, type: a.type, status: a.status, ...stats[a.id] })) };
    const out = await this.brain.plan(summary, now);
    if (!this._current(epoch)) return;
    this._aiSpent({ ...out, asked: 1 });
    const applied = [], refused = [];
    for (const action of out.actions) {
      const verdict = R.allowSuggestion(action, st.roster, st.config, now);
      if (verdict.ok) { this._applyRoster(verdict.action, now, "ai"); applied.push(`${action.op} ${action.agent}`); }
      else refused.push(`${action.op} ${action.agent}: ${verdict.reason}`);
    }
    st.ai.notes.push({ at: now, note: out.note, applied, refused, model: out.model });
    st.ai.notes = st.ai.notes.slice(-10);
    this._journal({ kind: "ai", task: "plan", applied, refused, note: out.note, costUsd: r6(out.costUsd), model: out.model });
    this._save();
  }
}

module.exports = { AgentDesk, DEFAULT_CONFIG, LIMITS, validateConfig, validateState, initialState, SHRINK, DECIDED, TICK_MS };
