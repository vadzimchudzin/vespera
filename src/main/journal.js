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
const REPLAY_TYPES = new Set([
  "order_sent",
  "test_order",
  "settled",
  "settlement_provisional",
  "settlement_failed",
  "paper_reset",
  "mode",
  "dry_run",
  "lot_confirmed",
]);

class Journal {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_BYTES;
    this.maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : MAX_FILES;
    this.maxMemoryEntries =
      Number(options.maxMemoryEntries) > 0 ? Number(options.maxMemoryEntries) : MAX_MEMORY_ENTRIES;
    this.statePath = `${this.filePath}.state.json`;
    this.pendingPath = `${this.filePath}.pending.json`;
    this.entries = [];
    this._restoreEntries = [];
    this.restoreEntries = this._restoreEntries;
    this._sequence = 0;
    this._checkpointNeedsSave = false;
    this._pendingOrder = null;
    this._loadState();
    this._loadPendingOrder();
    this._load();
  }

  _atomicJson(filePath, value, mode = 0o600) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tempPath, "wx", mode);
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      if (fd !== undefined && fd !== null) fs.closeSync(fd);
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  }

  _loadState() {
    if (!fs.existsSync(this.statePath)) return;
    const state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    if (!state || state.version !== 1 || !Array.isArray(state.entries) ||
        (state.sequence != null && (!Number.isSafeInteger(state.sequence) || state.sequence < 0))) {
      throw new Error("Corrupted journal state checkpoint");
    }
    if (state.entries.some((entry) => !entry || typeof entry !== "object" || !REPLAY_TYPES.has(entry.type))) {
      throw new Error("Corrupted journal state checkpoint");
    }
    this._sequence = state.sequence || 0;
    this._restoreEntries = state.entries.map((entry) => {
      if (Number.isSafeInteger(entry.seq) && entry.seq > 0) {
        this._sequence = Math.max(this._sequence, entry.seq);
        return entry;
      }
      this._checkpointNeedsSave = true;
      return { ...entry, seq: ++this._sequence };
    });
    this._restoreEntries = this._limitRestoreEntries(this._restoreEntries);
    this.restoreEntries = this._restoreEntries;
  }

  _loadPendingOrder() {
    if (!fs.existsSync(this.pendingPath)) return;
    let pending;
    try {
      pending = JSON.parse(fs.readFileSync(this.pendingPath, "utf8"));
    } catch {
      throw new Error("Corrupted pending order state; refusing to continue");
    }
    if (!pending || pending.version !== 1 || !pending.entry || typeof pending.entry !== "object" ||
        !pending.entry.clientOrderId) {
      throw new Error("Corrupted pending order state; refusing to continue");
    }
    this._pendingOrder = pending.entry;
  }

  _limitRestoreEntries(entries) {
    const retained = entries.slice(-this.maxMemoryEntries);
    const protectedEntries = new Set();
    const lastByBook = new Map();
    let lastPaperReset = null;
    let lastTestOrder = null;
    for (const entry of entries) {
      if (entry.type === "paper_reset") lastPaperReset = entry;
      if (entry.type === "test_order") lastTestOrder = entry;
      if (entry.type === "order_sent" || entry.type === "settled" || entry.type === "settlement_provisional") {
        const book = entry.mode === "auto" ? (entry.dryRun ? "dry" : "live") : "paper";
        lastByBook.set(book, entry);
      }
    }
    for (const entry of lastByBook.values()) protectedEntries.add(entry);
    if (lastPaperReset) protectedEntries.add(lastPaperReset);
    if (lastTestOrder) protectedEntries.add(lastTestOrder);

    // Keep the active risk segment intact even if an operator confirms the
    // lot thousands of times; only consecutive confirmations without a loss
    // are redundant. A reset or win starts a new segment.
    let segmentStart = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type === "paper_reset" || entry.type === "mode" || entry.type === "dry_run" ||
          (entry.type === "lot_confirmed" && entry.resetRisk === true) ||
          (entry.type === "settled" && entry.status === "win")) {
        segmentStart = i;
        break;
      }
    }
    if (segmentStart < 0 && entries.length) segmentStart = 0;
    if (segmentStart >= 0) {
      protectedEntries.add(entries[segmentStart]);
      let lossSinceConfirm = false;
      for (let i = segmentStart + 1; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry.type === "settled" && entry.status === "loss") {
          protectedEntries.add(entry);
          lossSinceConfirm = true;
        } else if (entry.type === "lot_confirmed" && lossSinceConfirm) {
          protectedEntries.add(entry);
          lossSinceConfirm = false;
        }
      }
    }
    const combined = new Set([...retained, ...protectedEntries]);
    return entries.filter((entry) => combined.has(entry));
  }

  _saveState(entries, sequence = this._sequence) {
    const next = this._limitRestoreEntries(entries);
    this._sequence = Math.max(sequence, ...next.map((entry) => Number(entry.seq) || 0));
    this._atomicJson(this.statePath, { version: 1, sequence: this._sequence, entries: next });
    this._restoreEntries = next;
    this.restoreEntries = this._restoreEntries;
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
    // The checkpoint is written before the JSONL append, so after a crash it
    // may intentionally be ahead of the journal. Its sequence watermark wins.
    const diskEntries = this.readAll().filter((entry) => entry && REPLAY_TYPES.has(entry.type));
    const remainingLegacy = new Map();
    for (const entry of this._restoreEntries) {
      if (!Number.isSafeInteger(entry.seq)) continue;
      const key = this._legacyKey(entry);
      remainingLegacy.set(key, (remainingLegacy.get(key) || 0) + 1);
    }
    const newer = [];
    const externalLegacy = [];
    let lastMatchedLegacyIndex = -1;
    const unmatchedLegacy = [];
    for (let i = 0; i < diskEntries.length; i += 1) {
      const entry = diskEntries[i];
      if (Number.isSafeInteger(entry.seq) && entry.seq > this._sequence) {
        newer.push(entry);
        continue;
      }
      if (Number.isSafeInteger(entry.seq)) continue;
      const key = this._legacyKey(entry);
      const count = remainingLegacy.get(key) || 0;
      if (count) {
        remainingLegacy.set(key, count - 1);
        lastMatchedLegacyIndex = i;
      } else {
        unmatchedLegacy.push({ entry, index: i });
      }
    }
    // With legacy rows there is no sequence to distinguish rotated-away old
    // records from later appends. Only rows after the last checkpoint match
    // can be external appends; keep checkpoint order untouched.
    externalLegacy.push(...unmatchedLegacy
      .filter(({ index }) => index > lastMatchedLegacyIndex)
      .map(({ entry }) => entry));
    if (!fs.existsSync(this.statePath)) {
      // One-time migration preserves the file order for legacy events.
      const merged = [];
      let nextSequence = this._sequence;
      for (const entry of diskEntries) {
        const row = Number.isSafeInteger(entry.seq) ? entry : { ...entry, seq: ++nextSequence };
        merged.push(row);
      }
      this._sequence = nextSequence;
      if (merged.length || this._checkpointNeedsSave) this._saveState(merged);
      return;
    }
    if (newer.length || externalLegacy.length || this._checkpointNeedsSave) {
      newer.sort((a, b) => a.seq - b.seq);
      this._sequence = Math.max(this._sequence, ...newer.map((entry) => entry.seq));
      const appendedLegacy = externalLegacy.map((entry) => ({ ...entry, seq: ++this._sequence }));
      this._saveState([...this._restoreEntries, ...newer, ...appendedLegacy]);
    }
  }

  _legacyKey(entry) {
    const { seq, ...legacy } = entry;
    return JSON.stringify(legacy);
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
    if (REPLAY_TYPES.has(row.type)) row.seq = ++this._sequence;
    const line = `${JSON.stringify(row)}\n`;
    if (REPLAY_TYPES.has(row.type)) this._saveState([...this._restoreEntries, row], row.seq);
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
    const entries = this.restoreEntries;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
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
    for (const e of this.restoreEntries) {
      // the engine starts a fresh series on these; a restart must too
      if (e.type === "paper_reset" || e.type === "mode" || e.type === "dry_run" ||
          (e.type === "lot_confirmed" && e.resetRisk === true)) {
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

  beginOrder(entry) {
    if (!entry || typeof entry !== "object" || !entry.clientOrderId) {
      throw new Error("Pending order requires a clientOrderId");
    }
    if (this._pendingOrder) throw new Error("A pending order already exists");
    this._atomicJson(this.pendingPath, { version: 1, entry });
    this._pendingOrder = entry;
    return entry;
  }

  attachOrderEvidence(clientOrderId, evidence) {
    if (!this._pendingOrder || this._pendingOrder.clientOrderId !== clientOrderId) {
      throw new Error("Pending order clientOrderId mismatch");
    }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error("Order evidence must be an object");
    }
    const allowed = ["orderId", "maker", "tokenId", "slug", "side", "sizeUsd", "limitPrice", "feeRate", "feeExponent", "makerAddress", "signerAddress", "signatureType"];
    const safeEvidence = {};
    for (const key of allowed) {
      const value = evidence[key];
      if (value != null && ["string", "number"].includes(typeof value)) safeEvidence[key] = value;
    }
    const next = { ...this._pendingOrder, evidence: { ...(this._pendingOrder.evidence || {}), ...safeEvidence } };
    this._atomicJson(this.pendingPath, { version: 1, entry: next });
    this._pendingOrder = next;
    return next;
  }

  completeOrder(clientOrderId) {
    if (!this._pendingOrder) return false;
    if (this._pendingOrder.clientOrderId !== clientOrderId) {
      throw new Error("Pending order clientOrderId mismatch");
    }
    fs.rmSync(this.pendingPath, { force: true });
    this._pendingOrder = null;
    return true;
  }

  pendingOrder() {
    return this._pendingOrder;
  }

  tail(n = 80) {
    return this.entries.slice(-n).reverse();
  }
}

module.exports = { Journal, MAX_BYTES, MAX_FILES, MAX_MEMORY_ENTRIES };
