"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Append-only journal with rotation.
 *
 * TZ 10: keep the trade log on disk, rotate it (10 MB x 5 files) and restore
 * the martingale series and any open bet after a restart.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_MEMORY_ENTRIES = 5000;

class Journal {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_BYTES;
    this.maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : MAX_FILES;
    this.maxMemoryEntries =
      Number(options.maxMemoryEntries) > 0 ? Number(options.maxMemoryEntries) : MAX_MEMORY_ENTRIES;
    this.entries = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const tail = lines.slice(-this.maxMemoryEntries);
        this.entries = tail
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch {
      this.entries = [];
    }
  }

  /** journal.jsonl -> journal.jsonl.1 -> ... -> journal.jsonl.{maxFiles}, oldest dropped. */
  _rotate() {
    try {
      const oldest = `${this.filePath}.${this.maxFiles}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const from = `${this.filePath}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
      }
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* rotation must never break trading */
    }
  }

  _rotateIfNeeded(nextChunkBytes) {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const size = fs.statSync(this.filePath).size;
      if (size + nextChunkBytes > this.maxBytes) this._rotate();
    } catch {
      /* ignore */
    }
  }

  /**
   * Every entry still on disk, oldest first: rotated files .N … .1, then the
   * live file. Memory only keeps the newest entries; exports need all of them.
   */
  readAll() {
    const files = [];
    for (let i = this.maxFiles; i >= 1; i -= 1) files.push(`${this.filePath}.${i}`);
    files.push(this.filePath);
    const out = [];
    for (const file of files) {
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* a torn last line after a crash */
        }
      }
    }
    return out;
  }

  write(entry) {
    const row = { ts: new Date().toISOString(), ...entry };
    const line = `${JSON.stringify(row)}\n`;
    this.entries.push(row);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(this.filePath, line);
    return row;
  }

  lastOpenBet() {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i];
      if (e.type === "order_sent") return e;
      if (e.type === "settled") return null;
    }
    return null;
  }

  /** maxSteps comes from settings; the halt threshold must follow it, not a constant. */
  restoreRisk(maxSteps = 6) {
    const limit = Math.max(1, Number(maxSteps) || 6);
    let step = 1;
    let losses = 0;
    let seriesLoss = 0;
    let halted = false;
    for (const e of this.entries) {
      // the engine starts a fresh series on these; a restart must too
      if (e.type === "paper_reset" || e.type === "mode" || e.type === "dry_run") {
        step = 1;
        losses = 0;
        seriesLoss = 0;
        halted = false;
      }
      if (e.type === "settled") {
        if (e.status === "win") {
          step = 1;
          losses = 0;
          seriesLoss = 0;
          halted = false;
        } else if (e.status === "loss") {
          losses += 1;
          seriesLoss += Math.abs(Number(e.pnl) || 0);
          if (losses >= limit) {
            halted = true;
          } else {
            step += 1;
          }
        }
      }
      // Mirrors Risk.confirmLot: confirming only restarts a halted series.
      // Settings → Save confirms the lot every time; mid-series that must not reset.
      if (e.type === "lot_confirmed" && halted) {
        halted = false;
        step = 1;
        losses = 0;
        seriesLoss = 0;
      }
    }
    return { step, consecutiveLosses: losses, seriesLossUsd: seriesLoss, halted };
  }

  tail(n = 80) {
    return this.entries.slice(-n).reverse();
  }
}

module.exports = { Journal, MAX_BYTES, MAX_FILES, MAX_MEMORY_ENTRIES };
