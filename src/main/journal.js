"use strict";

const fs = require("fs");
const path = require("path");

class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        this.entries = raw
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }
    } catch {
      this.entries = [];
    }
  }

  write(entry) {
    const row = { ts: new Date().toISOString(), ...entry };
    this.entries.push(row);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`);
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

  restoreRisk() {
    let step = 1;
    let losses = 0;
    let halted = false;
    for (const e of this.entries) {
      if (e.type === "settled") {
        if (e.status === "win") {
          step = 1;
          losses = 0;
          halted = false;
        } else if (e.status === "loss") {
          losses += 1;
          if (losses >= 6) {
            halted = true;
          } else {
            step += 1;
          }
        }
      }
      if (e.type === "lot_confirmed") {
        halted = false;
        step = 1;
        losses = 0;
      }
    }
    return { step, consecutiveLosses: losses, halted };
  }

  tail(n = 80) {
    return this.entries.slice(-n).reverse();
  }
}

module.exports = { Journal };
