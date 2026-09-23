"use strict";

/**
 * CSV export, per-day stats, reading rotated journals, and renderer
 * sanity (syntax + EN/RU key parity) so UI slips fail CI too.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Journal } = require("./journal");
const { toCsv, dailyBreakdown } = require("./stats");

// ── CSV ──────────────────────────────────────────────────────────────────────
{
  const { csv, count } = toCsv([
    { type: "setup" },
    { ts: "2026-09-23T10:00:00.000Z", type: "settled", side: "UP", sizeUsd: "2.50", entryPrice: 0.5, shares: 5, feeUsd: "0.09", outcome: "UP", status: "win", pnl: "2.41", slug: "btc-updown-15m-1" },
    { ts: "2026-09-23T10:15:00.000Z", type: "settled", mode: "auto", dryRun: true, side: "DOWN", sizeUsd: "5.00", status: "loss", pnl: "-5.18", orderId: 'a"b,c' },
  ]);
  assert.strictEqual(count, 2, "only settled bets");
  assert.ok(csv.startsWith("\ufeff"), "UTF-8 BOM for Excel");
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith("time,book,side,stake_usd,entry_price"));
  assert.ok(lines[1].includes(",paper,UP,2.50,0.5,5,0.09,"));
  assert.ok(lines[2].includes(",dry,DOWN,5.00,"), "books are labelled");
  assert.ok(lines[2].endsWith(',"a""b,c"'), "cells with quotes / commas are escaped");
  assert.strictEqual(toCsv([]).count, 0);
}

// ── per day ──────────────────────────────────────────────────────────────────
{
  const at = (d, h) => new Date(2026, 8, d, h).toISOString();
  const rows = dailyBreakdown(
    [
      { ts: at(22, 10), type: "settled", status: "win", pnl: "1.00", feeUsd: "0.04" },
      { ts: at(23, 9), type: "settled", status: "loss", pnl: "-1.04", feeUsd: "0.04" },
      { ts: at(23, 11), type: "settled", status: "win", pnl: "2.00", feeUsd: "0.07" },
      { ts: at(23, 12), type: "settled", mode: "auto", status: "win", pnl: "50" },
    ],
    "paper"
  );
  assert.deepStrictEqual(rows.map((r) => r.day), ["2026-09-23", "2026-09-22"], "newest first, local days");
  assert.deepStrictEqual([rows[0].bets, rows[0].wins, rows[0].pnl, rows[0].fees, rows[0].winRate], [2, 1, 0.96, 0.11, 0.5]);
}

// ── rotated journal is read in full, oldest first ────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-export-"));
  const j = new Journal(path.join(dir, "journal.jsonl"), { maxBytes: 300, maxFiles: 3, maxMemoryEntries: 2 });
  for (let i = 0; i < 8; i += 1) j.write({ type: "settled", n: i, pnl: "1.00", padding: "x".repeat(40) });
  assert.ok(fs.existsSync(path.join(dir, "journal.jsonl.1")), "rotation happened");
  assert.strictEqual(j.entries.length, 2, "memory keeps only the tail");
  const all = j.readAll().map((e) => e.n);
  assert.ok(all.length > 2, "export sees rotated files too");
  assert.deepStrictEqual(all, [...all].sort((a, b) => a - b), "oldest first");
  assert.strictEqual(all[all.length - 1], 7);
}

// ── renderer sanity ──────────────────────────────────────────────────────────
{
  const dir = path.join(__dirname, "..", "renderer");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    new vm.Script(fs.readFileSync(path.join(dir, file), "utf8"), { filename: file }); // throws on a syntax error
  }
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dir, "i18n.js"), "utf8"), sandbox);
  const { en, ru } = sandbox.window.VSP_I18N;
  const missingRu = Object.keys(en).filter((k) => !(k in ru));
  const missingEn = Object.keys(ru).filter((k) => !(k in en));
  assert.deepStrictEqual([missingRu, missingEn], [[], []], "EN and RU have the same keys");
  // every t("key") used by the app exists
  const app = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  const used = [...app.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((k) => !(k in en));
  assert.deepStrictEqual(unknown, [], `unknown i18n keys: ${unknown.join(", ")}`);
}

console.log("export + renderer tests ok");
