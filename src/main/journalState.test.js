"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Journal } = require("./journal");

function tempJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-journal-state-"));
  return { dir, file: path.join(dir, "journal.jsonl") };
}

// Replay state survives rotation and remains separate for paper and live books.
{
  const { dir, file } = tempJournal();
  const options = { maxBytes: 180, maxFiles: 2 };
  const journal = new Journal(file, options);
  journal.write({ type: "paper_reset", balance: "1000.00" });
  journal.write({ type: "order_sent", clientOrderId: "paper-1", side: "UP", sizeUsd: "1", balanceAfter: "999" });
  journal.write({ type: "settled", status: "loss", pnl: "-1.04", balanceAfter: "997.96" });
  journal.write({ type: "mode", mode: "auto" });
  journal.write({
    type: "order_sent",
    mode: "auto",
    clientOrderId: "live-1",
    side: "DOWN",
    sizeUsd: "2",
    balanceAfter: "12.34",
    roundCloseTs: 12345,
    orderId: "venue-1",
  });

  for (let i = 0; i < 40; i += 1) journal.write({ type: "diagnostic", message: `noise-${i}` });
  const restored = new Journal(file, options);
  const events = restored.restoreEntries;
  assert.ok(events.some((e) => e.type === "paper_reset"), "paper reset retained after log rotation");
  assert.ok(events.some((e) => e.type === "settled" && e.mode !== "auto"), "paper risk event retained");
  const open = restored.restoreEntries.find((e) => e.type === "order_sent" && e.clientOrderId === "live-1");
  assert.deepStrictEqual(
    [open.mode, open.balanceAfter, open.roundCloseTs, open.orderId],
    ["auto", "12.34", 12345, "venue-1"],
    "checkpoint retains live order context without blending book state"
  );
  assert.strictEqual(restored.lastOpenBet().clientOrderId, "live-1");
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 1,
    consecutiveLosses: 0,
    seriesLossUsd: 0,
    halted: false,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Diagnostic events beyond the memory cap do not evict replay-relevant state.
{
  const { dir, file } = tempJournal();
  const journal = new Journal(file, { maxBytes: 256, maxFiles: 1 });
  journal.write({ type: "settled", status: "loss", pnl: "-1.25" });
  for (let i = 0; i < 5200; i += 1) journal.write({ type: "diagnostic", message: `event-${i}` });
  journal.write({ type: "settled", status: "loss", pnl: "-2.50" });
  const restored = new Journal(file, { maxBytes: 256, maxFiles: 1 });
  assert.strictEqual(restored.restoreEntries.filter((e) => e.type === "settled").length, 2);
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 3,
    consecutiveLosses: 2,
    seriesLossUsd: 3.75,
    halted: false,
  });
  assert.ok(restored.restoreEntries.length < 10, "checkpoint does not retain noisy journal history");
  fs.rmSync(dir, { recursive: true, force: true });
}

// Rows at/below the checkpoint watermark never replay after an equal-timestamp win.
{
  const { dir, file } = tempJournal();
  const journal = new Journal(file, { maxMemoryEntries: 1, maxBytes: 1024 * 1024, maxFiles: 3 });
  const ts = "2026-01-01T00:00:00.000Z";
  const oldLoss = journal.write({ type: "settled", ts, status: "loss", pnl: "-2.00" });
  const win = journal.write({ type: "settled", ts, status: "win", pnl: "1.00" });
  assert.ok(win.seq > oldLoss.seq);

  fs.appendFileSync(file, `${JSON.stringify(oldLoss)}\n`);
  const restored = new Journal(file, { maxMemoryEntries: 1, maxBytes: 1024 * 1024, maxFiles: 3 });
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 1,
    consecutiveLosses: 0,
    seriesLossUsd: 0,
    halted: false,
  });
  assert.deepStrictEqual(restored.restoreEntries.map((entry) => entry.seq), [win.seq]);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Pre-checkpoint JSONL events migrate in file order and receive stable sequences.
{
  const { dir, file } = tempJournal();
  const ts = "2025-01-01T00:00:00.000Z";
  fs.writeFileSync(file, [
    { ts, type: "settled", status: "loss", pnl: "-1.00" },
    { ts, type: "settled", status: "win", pnl: "0.96" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const migrated = new Journal(file);
  assert.deepStrictEqual(migrated.restoreEntries.map((entry) => entry.seq), [1, 2]);
  assert.deepStrictEqual(migrated.restoreRisk(6), {
    step: 1,
    consecutiveLosses: 0,
    seriesLossUsd: 0,
    halted: false,
  });
  assert.strictEqual(new Journal(file).restoreEntries.map((entry) => entry.seq).join(","), "1,2");
  fs.rmSync(dir, { recursive: true, force: true });
}

// A row appended outside Journal after checkpoint creation is merged on restart.
{
  const { dir, file } = tempJournal();
  const journal = new Journal(file);
  journal.write({ type: "paper_reset", balance: "1000.00" });
  const externalOrder = {
    ts: new Date(Date.now() + 1000).toISOString(),
    type: "order_sent",
    clientOrderId: "external-paper-order",
    side: "UP",
    sizeUsd: "1.00",
    balanceAfter: "999.00",
  };
  fs.appendFileSync(file, `${JSON.stringify(externalOrder)}\n`);

  const restored = new Journal(file);
  assert.strictEqual(restored.lastOpenBet().clientOrderId, externalOrder.clientOrderId);
  assert.ok(restored.restoreEntries.some((entry) => entry.clientOrderId === externalOrder.clientOrderId));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Active losses survive more than the checkpoint cap of confirmations.
{
  const { dir, file } = tempJournal();
  const journal = new Journal(file, { maxMemoryEntries: 8, maxBytes: 256, maxFiles: 1 });
  for (let i = 0; i < 3; i += 1) {
    journal.write({ type: "settled", status: "loss", pnl: "-1.00" });
  }
  for (let i = 0; i < 5200; i += 1) journal.write({ type: "lot_confirmed", baseUsd: "1.00" });

  const restored = new Journal(file, { maxMemoryEntries: 8, maxBytes: 256, maxFiles: 1 });
  assert.strictEqual(restored.restoreEntries.filter((entry) => entry.type === "settled" && entry.status === "loss").length, 3);
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 4,
    consecutiveLosses: 3,
    seriesLossUsd: 3,
    halted: false,
  });
  assert.deepStrictEqual(restored.restoreRisk(3), {
    step: 1,
    consecutiveLosses: 0,
    seriesLossUsd: 0,
    halted: false,
  });
  assert.ok(restored.restoreEntries.length < 20, "redundant confirmations remain bounded");
  fs.rmSync(dir, { recursive: true, force: true });
}

// Explicit resetRisk confirmations bound repeated, completed halted cycles.
{
  const { dir, file } = tempJournal();
  const options = { maxMemoryEntries: 8, maxBytes: 256, maxFiles: 1 };
  const journal = new Journal(file, options);
  for (let cycle = 0; cycle < 100; cycle += 1) {
    journal.write({ type: "settled", status: "loss", pnl: "-1.00" });
    journal.write({ type: "settled", status: "loss", pnl: "-1.00" });
    journal.write({ type: "lot_confirmed", baseUsd: "1.00", resetRisk: true });
  }
  journal.write({ type: "settled", status: "loss", pnl: "-2.00" });
  const restored = new Journal(file, options);
  const riskEvents = restored.restoreEntries.filter((entry) => entry.type === "settled");
  assert.ok(riskEvents.length <= options.maxMemoryEntries, "reset cycles remain under the replay cap");
  const latestReset = restored.restoreEntries.findLastIndex((entry) => entry.type === "lot_confirmed" && entry.resetRisk);
  assert.strictEqual(
    restored.restoreEntries.slice(latestReset + 1).filter((entry) => entry.type === "settled" && entry.status === "loss").length,
    1,
    "active post-reset loss remains available for restore"
  );
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 2,
    consecutiveLosses: 1,
    seriesLossUsd: 2,
    halted: false,
  });
  assert.ok(restored.restoreEntries.length <= options.maxMemoryEntries, "repeated reset cycles remain bounded");
  fs.rmSync(dir, { recursive: true, force: true });
}

// The latest test-order lock survives replay retention and does not affect risk.
{
  const { dir, file } = tempJournal();
  const options = { maxMemoryEntries: 4, maxBytes: 256, maxFiles: 1 };
  const journal = new Journal(file, options);
  const testOrder = journal.write({
    type: "test_order",
    mode: "auto",
    dryRun: false,
    clientOrderId: "test-lock-1",
    roundCloseTs: 987654321,
  });
  for (let cycle = 0; cycle < 30; cycle += 1) {
    journal.write({ type: "settled", status: "loss", pnl: "-1.00" });
    journal.write({ type: "lot_confirmed", resetRisk: true });
  }

  const restored = new Journal(file, options);
  const restoredTestOrder = restored.restoreEntries.find((entry) => entry.type === "test_order");
  assert.deepStrictEqual(
    [restoredTestOrder.seq, restoredTestOrder.clientOrderId, restoredTestOrder.roundCloseTs, restoredTestOrder.mode, restoredTestOrder.dryRun],
    [testOrder.seq, "test-lock-1", 987654321, "auto", false]
  );
  assert.deepStrictEqual(restored.restoreRisk(6), {
    step: 1,
    consecutiveLosses: 0,
    seriesLossUsd: 0,
    halted: false,
  });
  assert.ok(restored.restoreEntries.length <= options.maxMemoryEntries + 3, "test-order lock adds only bounded protected replay rows");
  fs.rmSync(dir, { recursive: true, force: true });
}

// Pending orders are private durable state, and malformed state fails closed.
{
  const { dir, file } = tempJournal();
  let journal = new Journal(file);
  const order = { clientOrderId: "unknown-1", side: "UP", sizeUsd: "1.00" };
  journal.beginOrder(order);
  assert.strictEqual(fs.statSync(`${file}.pending.json`).mode & 0o777, 0o600);
  journal = new Journal(file);
  assert.deepStrictEqual(journal.pendingOrder(), order);
  assert.throws(() => journal.completeOrder("other-id"), /mismatch/);
  assert.deepStrictEqual(journal.pendingOrder(), order, "mismatched completion leaves marker intact");
  assert.strictEqual(journal.completeOrder(order.clientOrderId), true);
  assert.strictEqual(journal.completeOrder(order.clientOrderId), false, "completion without a pending marker is harmless");
  assert.strictEqual(new Journal(file).pendingOrder(), null);

  fs.writeFileSync(`${file}.pending.json`, "{broken");
  assert.throws(() => new Journal(file), /Corrupted pending order state/);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("journal state tests ok");
