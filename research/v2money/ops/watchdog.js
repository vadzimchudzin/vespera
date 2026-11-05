#!/usr/bin/env node
// watchdog.js — the 24/7 operator for the paper bots: are they alive, are their files fresh, are their feeds open.
// One check prints one JSON line and exits 1 when something is wrong (cron-friendly); --every N repeats every N seconds.
//
//   node ops/watchdog.js [--dir .] [--collector DIR] [--lanes DIR] [--stale-min 5] [--every 60]
//
// --dir        the run.sh folder: out/ (latbot.js) and lpout/ (lp_paper.js); a bot without a pid file and without
//              output is treated as not deployed, not as down
// --collector  the folder of scripts/collect.js (state.json): process heartbeat and per-feed age
// --lanes      userData/agents/lanes of the agents desk: latency.json and lp.json are re-saved every 60 s while running
// Telegram: with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set, new and cleared alerts are sent (only changes; the last
// alert set is kept in <dir>/watchdog.state.json). Paper only: the watchdog reads files, it never trades.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function parse(argv) {
  const o = { dir: ".", collector: null, lanes: null, staleMin: 5, every: 0 };
  const map = { "--dir": "dir", "--collector": "collector", "--lanes": "lanes", "--stale-min": "staleMin", "--every": "every" };
  for (let i = 0; i < argv.length; i += 1) {
    const k = map[argv[i]];
    if (!k || argv[i + 1] == null) throw new Error(`invalid argument: ${argv[i]}`);
    o[k] = ["staleMin", "every"].includes(k) ? Number(argv[++i]) : argv[++i];
  }
  if (!(o.staleMin > 0) || !(o.every >= 0)) throw new Error("invalid --stale-min/--every");
  return o;
}

// The last complete JSON line of a growing JSONL file (reads only the tail).
function lastLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch { /* partial line */ } }
    return null;
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function pidState(file) {
  let pid;
  try { pid = Number(fs.readFileSync(file, "utf8").trim()); } catch { return null; }
  try { process.kill(pid, 0); return { pid, alive: true }; } catch (e) { return { pid, alive: e.code === "EPERM" }; }
}
const ageMin = (t, now) => (Number.isFinite(t) ? Math.round((now - t) / 600) / 100 : null);

function check(o, now = Date.now()) {
  const items = {}, alerts = [], stale = o.staleMin;
  const bot = (name, sub, file, extra) => {
    const pid = pidState(path.join(o.dir, sub, "pid")), last = lastLine(path.join(o.dir, sub, file));
    if (!pid && !last) { items[name] = { deployed: false }; return; }
    const age = ageMin(last && last.t, now);
    items[name] = { pid: pid && pid.pid, alive: pid ? pid.alive : null, ageMin: age, ...(last ? extra(last) : {}) };
    if (pid && !pid.alive) alerts.push(`${name}_down`);
    if (age == null || age > stale) alerts.push(`${name}_stale`);
  };
  bot("latbot", "out", "status.jsonl", (s) => {
    if (s.clobOpen === false) alerts.push("latbot_clob_closed");
    return { clobOpen: s.clobOpen, windows: s.wins, open: s.open };
  });
  bot("lp", "lpout", "minutes.jsonl", (m) => {
    if (m.rtds && m.rtds.open === false) alerts.push("lp_rtds_down");
    const net = Object.fromEntries(Object.entries(m.tot || {}).map(([v, x]) => [v, Math.round((x.rP + x.mtm) * 100) / 100]));
    return { markets: m.ok, rtdsOpen: m.rtds ? m.rtds.open : null, netPess: net };
  });
  if (o.collector) {
    const s = readJson(path.join(o.collector, "state.json"));
    const age = ageMin(s && s.at, now), feeds = {};
    if (!s || s.stopped || age == null || age > stale) alerts.push("collector_stale");
    for (const [k, f] of Object.entries((s && s.feeds) || {})) {
      const a = ageMin(f && f.last, now); feeds[k] = a;
      if (a == null || a > stale) alerts.push(`collector_feed_stale:${k}`);
    }
    items.collector = { ageMin: age, stopped: s ? s.stopped : null, feeds };
  }
  if (o.lanes) {
    for (const f of ["latency.json", "lp.json"]) {
      let m = null;
      try { m = fs.statSync(path.join(o.lanes, f)).mtimeMs; } catch { /* not created yet */ }
      const a = ageMin(m, now);
      items[`lane_${f.replace(".json", "")}`] = { ageMin: a };
      if (a != null && a > stale) alerts.push(`lane_stale:${f.replace(".json", "")}`);
    }
  }
  return { at: new Date(now).toISOString(), ok: alerts.length === 0, alerts, items };
}

const TEXT = {
  latbot_down: "латентный бот остановился", latbot_stale: "латентный бот не пишет статус", latbot_clob_closed: "у латентного бота закрыт CLOB",
  lp_down: "LP-симуляция остановилась", lp_stale: "LP-симуляция не пишет данные", lp_rtds_down: "у LP-симуляции отключён поток сделок RTDS",
  collector_stale: "коллектор не обновляет состояние",
};
const say = (a) => TEXT[a] || (a.startsWith("collector_feed_stale:") ? `коллектор: поток ${a.split(":")[1]} молчит`
  : a.startsWith("lane_stale:") ? `полоса ${a.split(":")[1]} не сохраняется (остановлена?)` : a);

async function notify(o, report, env = process.env, send = null) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  const file = path.join(o.dir, "watchdog.state.json");
  const prev = new Set((readJson(file) || {}).alerts || []), cur = new Set(report.alerts);
  const added = [...cur].filter((a) => !prev.has(a)), cleared = [...prev].filter((a) => !cur.has(a));
  try { fs.writeFileSync(file, JSON.stringify({ at: report.at, alerts: [...cur] })); } catch { /* read-only dir: no memory */ }
  if (!token || !chat || (!added.length && !cleared.length)) return null;
  const lines = ["Vespera, бумажные боты"];
  if (added.length) lines.push(`⚠️ ${added.map(say).join("; ")}`);
  if (cleared.length) lines.push(`✅ снова в порядке: ${cleared.map(say).join("; ")}`);
  const text = lines.join("\n");
  const post = send || (async (body) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`telegram_${r.status}`);
  });
  await post({ chat_id: chat, text });
  return text;
}

async function once(o) {
  const report = check(o);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  try { await notify(o, report); } catch (e) { process.stderr.write(`watchdog_notify_failed: ${e.message}\n`); }
  return report;
}

if (require.main === module) {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (o.every > 0) { once(o); setInterval(() => once(o), o.every * 1000); }
  else once(o).then((r) => { process.exitCode = r.ok ? 0 : 1; });
}

module.exports = { parse, check, notify, lastLine };
