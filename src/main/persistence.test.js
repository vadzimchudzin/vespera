"use strict";

/**
 * Persistence and credential handling.
 *
 * Covers the defects found in the 0.8.8 audit:
 *  - journal rotation and maxSteps-aware halt restore (TZ 10, TZ 6.4)
 *  - secrets encrypted at rest, empty inputs never wipe a stored key (TZ 11)
 *  - an arrow is only drawn for an order that actually happened (TZ 6.6)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Journal } = require("./journal");
const { SettingsStore, SECRET_FIELDS } = require("./settingsStore");
const { Engine } = require("./engine");
const { sma } = require("./strategy");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vespera-persist-"));
}

function bar(open, high, low, close, extra = {}) {
  return { open, high, low, close, volume: 1, closed: true, ...extra };
}

function makeTrendBars({ n = 222, close = 110, trend = 0.05 }) {
  const bars = [];
  let c = close;
  for (let i = 0; i < n; i += 1) {
    c += trend;
    const openTs = i * 900_000;
    bars.push(bar(c, c + 1, c - 1, c, { openTs, closeTs: openTs + 899_999 }));
  }
  return bars;
}

function paintLong(bars, index) {
  const closes = bars.map((b) => b.close);
  const ma20Prev = sma(closes, 20, index - 1);
  const prevTs = bars[index - 1].openTs;
  bars[index - 1] = bar(ma20Prev - 1, ma20Prev - 0.4, ma20Prev - 2, ma20Prev - 1.2, {
    openTs: prevTs,
    closeTs: prevTs + 899_999,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    index
  );
  const openTs = bars[index].openTs;
  bars[index] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2, { openTs, closeTs: openTs + 899_999 });
}

function fakeMarket(seed) {
  return {
    bars: seed.slice(),
    forming: null,
    listeners: new Set(),
    timer: 1,
    on(fn) {
      this.listeners.add(fn);
    },
    start() {
      this.timer = 1;
    },
    stop() {
      this.timer = null;
    },
    setRefreshMs() {},
    async configure() {},
    async loadHistory() {
      return this.bars;
    },
  };
}

function stubLive() {
  return {
    configure() {
      return this;
    },
    async ping() {
      return { ok: false, venue: "polymarket", message: "offline_test", trading: false };
    },
    async getBalance() {
      return null;
    },
    async marketBuy() {
      const err = new Error("auto_not_wired");
      err.code = "auto_not_wired";
      throw err;
    },
  };
}

async function run() {
  // --- journal rotation keeps at most maxFiles files
  {
    const dir = tmpDir();
    const file = path.join(dir, "journal.jsonl");
    const j = new Journal(file, { maxBytes: 2048, maxFiles: 3, maxMemoryEntries: 500 });
    for (let i = 0; i < 400; i += 1) j.write({ type: "skip", reason: "no_setup", pad: "x".repeat(64) });
    const files = fs.readdirSync(dir).sort();
    assert(files.includes("journal.jsonl"), "active journal exists");
    assert(!files.includes("journal.jsonl.4"), `rotation keeps 3 backups, got ${files.join(",")}`);
    assert(fs.statSync(file).size <= 2048 + 256, "active journal stays under the size cap");
    assert(j.entries.length <= 500, "in-memory entries are capped");
  }

  // --- halt threshold follows maxSteps, also after a restart
  {
    const dir = tmpDir();
    const file = path.join(dir, "journal.jsonl");
    const j = new Journal(file);
    for (let i = 0; i < 3; i += 1) {
      j.write({ type: "settled", status: "loss", side: "UP", pnl: "-1.00", balanceAfter: "997.00" });
    }
    const reloaded = new Journal(file);
    assert(reloaded.restoreRisk(3).halted === true, "3 losses halt a maxSteps=3 series");
    assert(reloaded.restoreRisk(6).halted === false, "3 losses do not halt a maxSteps=6 series");
    assert(reloaded.restoreRisk(6).step === 4, "step keeps growing below the limit");
  }

  // --- engine restores the halt flag with the configured maxSteps
  {
    const dir = tmpDir();
    const j = new Journal(path.join(dir, "journal.jsonl"));
    for (let i = 0; i < 3; i += 1) {
      j.write({ type: "settled", status: "loss", side: "UP", pnl: "-1.00", balanceAfter: "997.00" });
    }
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 3, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket([]),
    });
    assert(engine.risk.halted === true, "engine halts a maxSteps=3 series after a restart");
    assert(engine.risk.lotConfirmed === false, "halted series asks for a lot confirm");
  }

  // --- secrets are not written in plain text and survive an empty save
  {
    const dir = tmpDir();
    const store = new SettingsStore(dir);
    store.save({ apiKey: "KEY-1", apiSecret: "SECRET-1", apiPassphrase: "PASS-1", walletAddress: "0xabc" });
    const raw = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
    for (const secret of ["KEY-1", "SECRET-1", "PASS-1"]) {
      assert(!raw.includes(secret), `${secret} must not appear in settings.json`);
    }
    for (const key of SECRET_FIELDS) {
      assert(/^enc/.test(JSON.parse(raw)[key]), `${key} is stored encrypted`);
    }
    const reopened = new SettingsStore(dir);
    assert(reopened.value.apiKey === "KEY-1", "apiKey decrypts back");
    assert(reopened.value.apiSecret === "SECRET-1", "apiSecret decrypts back");
    assert(reopened.value.apiPassphrase === "PASS-1", "apiPassphrase decrypts back");

    // pressing OK again with empty fields must not erase anything
    reopened.save({ apiKey: "", apiSecret: "", apiPassphrase: "", walletAddress: "0xabc" });
    const after = new SettingsStore(dir);
    assert(after.value.apiKey === "KEY-1", "empty input keeps the stored apiKey");
    assert(after.value.apiSecret === "SECRET-1", "empty input keeps the stored apiSecret");
    assert(after.value.apiPassphrase === "PASS-1", "empty input keeps the stored apiPassphrase");

    // an explicit clear still works
    after.clearSecret("apiSecret");
    assert(new SettingsStore(dir).value.apiSecret === "", "clearSecret wipes on purpose");

    // legacy plain config is read and re-encrypted
    const legacyDir = tmpDir();
    fs.writeFileSync(path.join(legacyDir, "settings.json"), JSON.stringify({ apiKey: "OLDPLAIN" }));
    const migrated = new SettingsStore(legacyDir);
    assert(migrated.value.apiKey === "OLDPLAIN", "legacy plain key still loads");
    migrated.save({ theme: "glass-light" });
    assert(
      !fs.readFileSync(path.join(legacyDir, "settings.json"), "utf8").includes("OLDPLAIN"),
      "legacy key is re-encrypted on the next save"
    );
  }

  // --- engine keeps stored credentials when the panel sends empty fields
  {
    const dir = tmpDir();
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", apiKey: "K", apiSecret: "S", apiPassphrase: "P", walletAddress: "0xW" },
      live: stubLive(),
      market: fakeMarket([]),
    });
    await engine.pingApi({ apiKey: "", apiSecret: "", apiPassphrase: "", walletAddress: "0xW" });
    assert(engine.settings.apiKey === "K", "apiKey kept");
    assert(engine.settings.apiSecret === "S", "apiSecret kept");
    assert(engine.settings.apiPassphrase === "P", "apiPassphrase kept");
    const snap = engine.snapshot();
    assert(snap.settings.apiKey === "set", "snapshot masks the key");
    assert(snap.settings.apiSecret === undefined, "snapshot never carries the secret");
    assert(snap.settings.hasApiSecret === true, "snapshot reports that a secret is stored");
  }

  // --- no arrow for an order that never happened
  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m", paperBalance: "0.50" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    engine.market.bars = bars.slice(0, 219);
    await engine.start();
    engine.markers = [];
    engine.market.bars = bars.slice(0, 220);
    const stepBefore = engine.risk.step;
    await engine.onBarClose(bars[219]);
    assert(!engine.paper.openBet, "no bet without balance");
    assert(engine.markers.length === 0, "rejected order draws no arrow");
    assert(engine.risk.step === stepBefore, "rejected order does not move the martingale");
    const logged = engine.journal.entries.some(
      (e) => e.type === "order_error" && /insufficient_balance/.test(e.message)
    );
    assert(logged, "insufficient_balance is journaled");
  }

  // --- a real paper order still draws exactly one arrow
  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    engine.market.bars = bars.slice(0, 219);
    await engine.start();
    engine.markers = [];
    engine.market.bars = bars.slice(0, 220);
    await engine.onBarClose(bars[219]);
    assert(engine.paper.openBet, "paper bet opened");
    assert(engine.markers.length === 1, `exactly one arrow, got ${engine.markers.length}`);
    const interval = 900_000;
    assert(
      engine.markers[0].time === Math.floor((bars[219].openTs + interval) / 1000),
      "arrow sits on the entry candle S+1"
    );
  }

  console.log("persistence tests ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
