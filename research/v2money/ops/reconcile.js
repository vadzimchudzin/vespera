#!/usr/bin/env node
// reconcile.js — on-chain reconciliation for a live pilot: our journal against what Polymarket's public Data API v2
// shows for the wallet (trades incl. maker rows, open positions, rewards and rebates by day). Read-only, no keys.
//
//   node ops/reconcile.js --wallet 0xPROXY [--journal fills.jsonl] [--from 2026-11-05] [--to 2026-11-06]
//                         [--expect rewards.json] [--json]
//
// Journal: one JSON object per line; fields token|token_id|asset, side (BUY/SELL), size|shares, price|px,
// t|at|timestamp (ms or s), optional tx|transaction_hash. A journal trade matches an on-chain trade by transaction hash
// when it has one, otherwise by token + side, size within 1%, price within 0.5c and time within 180 s (nearest first).
// --expect: {"YYYY-MM-DD": expected reward USD} (e.g. from the LP lane or lp_paper.js); compared with REWARD payouts.
// Exit code 1 when anything is unmatched or a position differs.
"use strict";
const fs = require("node:fs");
const API = "https://data-api.polymarket.com/v2/";

function parse(argv) {
  const o = { wallet: null, journal: null, from: null, to: null, expect: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") { o.json = true; continue; }
    const k = { "--wallet": "wallet", "--journal": "journal", "--from": "from", "--to": "to", "--expect": "expect" }[a];
    if (!k || argv[i + 1] == null) throw new Error(`invalid argument: ${a}`);
    o[k] = argv[++i];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.wallet || "")) throw new Error("--wallet 0x... (proxy wallet) is required");
  const sec = (v) => (v == null ? null : /^\d+$/.test(v) ? Number(v) : Math.floor(Date.parse(v) / 1000));
  o.fromS = sec(o.from); o.toS = sec(o.to);
  if ([o.fromS, o.toS].some((x) => x !== null && !Number.isFinite(x))) throw new Error("invalid --from/--to");
  return o;
}

async function pages(endpoint, params, get, max = 50) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < max; i += 1) {
    const q = new URLSearchParams({ ...params, limit: "1000", ...(cursor ? { cursor } : {}) });
    const r = await get(`${API}${endpoint}?${q}`);
    out.push(...((r && r.data) || []));
    cursor = r && r.pagination && r.pagination.has_more ? r.pagination.next_cursor : null;
    if (!cursor) break;
  }
  return out;
}
async function httpGet(url) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "vespera-reconcile" }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) throw new Error(`data_api_${r.status}`);
    } catch (e) { if (i === 2 || /data_api_4/.test(e.message)) throw e; }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}

const num = (x) => (x == null || x === "" ? NaN : Number(x));
function normJournal(rows) {
  return rows.map((r, i) => {
    let t = num(r.t ?? r.at ?? r.timestamp);
    if (t < 1e12) t *= 1000;
    return { i, token: String(r.token ?? r.token_id ?? r.asset ?? ""), side: String(r.side || "").toUpperCase(),
      size: num(r.size ?? r.shares), price: num(r.price ?? r.px), t, tx: (r.tx ?? r.transaction_hash ?? "").toLowerCase() || null };
  }).filter((r) => r.token && ["BUY", "SELL"].includes(r.side) && r.size > 0 && Number.isFinite(r.t));
}
function normChain(rows) {
  return rows.map((r, i) => ({ i, token: String(r.token_id), side: String(r.side).toUpperCase(), size: num(r.size), price: num(r.price),
    t: num(r.timestamp) * 1000, tx: String(r.transaction_hash || "").toLowerCase() || null, slug: r.slug }));
}
// Greedy matching: transaction hash first, then the nearest trade in time within the tolerances.
function match(journal, chain, { sizeTol = 0.01, pxTol = 0.005, dtMs = 180000 } = {}) {
  const used = new Set(), pairs = [];
  const ok = (j, c) => c.token === j.token && c.side === j.side && Math.abs(c.size - j.size) <= sizeTol * Math.max(j.size, c.size) + 1e-9;
  for (const j of journal.filter((x) => x.tx)) {
    const c = chain.find((x) => !used.has(x.i) && x.tx === j.tx && ok(j, x));
    if (c) { used.add(c.i); pairs.push([j, c]); j.done = true; }
  }
  for (const j of journal.filter((x) => !x.done)) {
    let best = null;
    for (const c of chain) {
      if (used.has(c.i) || !ok(j, c) || Math.abs(c.price - j.price) > pxTol + 1e-9 || Math.abs(c.t - j.t) > dtMs) continue;
      if (!best || Math.abs(c.t - j.t) < Math.abs(best.t - j.t)) best = c;
    }
    if (best) { used.add(best.i); pairs.push([j, best]); j.done = true; }
  }
  return { pairs, onlyJournal: journal.filter((j) => !j.done), onlyChain: chain.filter((c) => !used.has(c.i)) };
}
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
function netByToken(rows) {
  const m = {};
  for (const r of rows) m[r.token] = (m[r.token] || 0) + (r.side === "BUY" ? r.size : -r.size);
  return m;
}

async function run(o, get = httpGet) {
  const win = { user: o.wallet, ...(o.fromS ? { start: String(o.fromS) } : {}), ...(o.toS ? { end: String(o.toS) } : {}) };
  const [trades, acts, positions] = [
    await pages("trades", { ...win, taker_only: "false" }, get),
    await pages("activity", { ...win, type: "REWARD,MAKER_REBATE,TAKER_REBATE,REDEEM,MERGE,SPLIT" }, get),
    await pages("positions", { user: o.wallet }, get, 10),
  ];
  const chain = normChain(trades);
  const journal = o.journal ? normJournal(fs.readFileSync(o.journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) : [];
  const inWin = (t) => (!o.fromS || t >= o.fromS * 1000) && (!o.toS || t <= o.toS * 1000);
  const m = match(journal.filter((j) => inWin(j.t)), chain);
  const flows = {};
  for (const a of acts) {
    const d = day(num(a.timestamp) * 1000), f = (flows[d] ||= {});
    f[a.type] = Math.round(((f[a.type] || 0) + num(a.usdc_size)) * 100) / 100;
  }
  const expect = o.expect ? JSON.parse(fs.readFileSync(o.expect, "utf8")) : null;
  const rewards = Object.keys({ ...flows, ...(expect || {}) }).sort().map((d) => ({ day: d, paid: (flows[d] || {}).REWARD || 0,
    expected: expect && expect[d] != null ? expect[d] : null }));
  // Positions: only meaningful when the journal covers the wallet's whole history.
  const jNet = netByToken(journal), posDiff = [];
  if (journal.length && !o.fromS) {
    const chainPos = Object.fromEntries(positions.map((p) => [String(p.token_id ?? p.asset ?? ""), num(p.current_size)]));
    for (const tk of new Set([...Object.keys(jNet), ...Object.keys(chainPos)])) {
      const a = jNet[tk] || 0, b = chainPos[tk] || 0;
      if (Math.abs(a - b) > 0.01 * Math.max(Math.abs(a), Math.abs(b), 1)) posDiff.push({ token: tk, journal: a, chain: b });
    }
  }
  return {
    wallet: o.wallet, window: { from: o.from, to: o.to },
    trades: { chain: chain.length, journal: journal.length, matched: m.pairs.length, onlyJournal: m.onlyJournal.length, onlyChain: m.onlyChain.length },
    slippageC: m.pairs.length ? Math.round(m.pairs.reduce((s, [j, c]) => s + (c.price - j.price) * (j.side === "BUY" ? 1 : -1), 0) / m.pairs.length * 1e4) / 100 : null,
    onlyJournal: m.onlyJournal.slice(0, 20), onlyChain: m.onlyChain.slice(0, 20).map(({ i, ...c }) => c),
    positions: { open: positions.length, differ: posDiff }, flows, rewards,
    ok: m.onlyJournal.length === 0 && m.onlyChain.length === 0 && posDiff.length === 0,
  };
}

function text(r) {
  const L = [`Кошелёк ${r.wallet}${r.window.from ? `, с ${r.window.from}` : ""}${r.window.to ? ` по ${r.window.to}` : ""}`,
    `Сделки: в сети ${r.trades.chain}, в журнале ${r.trades.journal}, совпали ${r.trades.matched}; только в журнале ${r.trades.onlyJournal}, только в сети ${r.trades.onlyChain}` +
      (r.slippageC != null ? `; средняя разница цены ${r.slippageC}¢ (плюс — хуже журнала)` : ""),
    `Открытых позиций: ${r.positions.open}${r.positions.differ.length ? `; расходятся: ${r.positions.differ.length}` : ""}`];
  if (r.rewards.length) L.push("Награды по дням (выплачено / ожидалось):", ...r.rewards.map((x) => `  ${x.day}: $${x.paid}${x.expected != null ? ` / $${x.expected}` : ""}`));
  const other = Object.entries(r.flows).filter(([, f]) => Object.keys(f).some((k) => k !== "REWARD"));
  if (other.length) L.push("Прочие движения:", ...other.map(([d, f]) => `  ${d}: ${Object.entries(f).filter(([k]) => k !== "REWARD").map(([k, v]) => `${k} $${v}`).join(", ")}`));
  L.push(r.ok ? "Итог: сходится." : "Итог: есть расхождения.");
  return L.join("\n");
}

if (require.main === module) {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  run(o).then((r) => { process.stdout.write(`${o.json ? JSON.stringify(r) : text(r)}\n`); process.exitCode = r.ok ? 0 : 1; })
    .catch((e) => { process.stderr.write(`reconcile_failed: ${e.message}\n`); process.exitCode = 2; });
}

module.exports = { parse, match, normJournal, normChain, run, text };
