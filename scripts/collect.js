#!/usr/bin/env node
"use strict";

/* Vespera data collector (V2 M0); docs/COLLECTOR.md.
 *   npm run collect                       records until Ctrl+C / SIGTERM (then finishes the open hour files)
 *   npm run collect -- check [day]        verifies a day (UTC; YYYY-MM-DD, today, yesterday; default today)
 *   npm run collect -- status             the heartbeat of a collector running on this folder
 * Options: --dir <path> (default ./collector-data or VESPERA_COLLECTOR_DIR), --assets btc,eth,sol,xrp,
 *          --tfs 5m,15m,1h,4h,1d, --gap-ms 5000, --book-sample-ms 250, --clob-shards 4, --json (check, status) */
const fs = require("node:fs");
const path = require("node:path");
const { Collector, STATE, LOCK } = require("../src/data/collector");
const { checkDay } = require("../src/data/check");
const { ASSETS, TFS } = require("../src/data/windows");
const { MANIFEST, utcDay } = require("../src/data/store");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const say = (msg) => process.stderr.write(`[${stamp()}] ${msg}\n`);
const mb = (n) => `${(n / 1048576).toFixed(1)} МБ`;
const sec = (ms) => `${(ms / 1000).toFixed(1)} с`;
const hm = (t) => (t == null ? "—" : new Date(t).toISOString().slice(11, 19));

function dayArg(v) {
  if (!v || v === "today") return utcDay(Date.now());
  if (v === "yesterday") return utcDay(Date.now() - 86400000);
  return v;
}

async function run(opt, dir) {
  const assets = opt.assets ? String(opt.assets).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : ASSETS;
  const tfs = opt.tfs ? String(opt.tfs).split(",").map((s) => s.trim()).filter(Boolean) : TFS;
  const bad = tfs.filter((t) => !TFS.includes(t));
  if (bad.length) throw new Error(`collector_tf_unsupported: ${bad.join(",")} (${TFS.join(", ")})`);
  const gapMs = Number(opt["gap-ms"] || 5000);
  const collector = new Collector({ dir, assets, tfs, gapMs, bookSampleMs: Number(opt["book-sample-ms"] ?? 250), clobShards: Number(opt["clob-shards"] || 4),
    log: (level, msg) => say(`${level}: ${msg}`) });
  try {
    await collector.start();
  } catch (e) {
    if (e.code === "collector_running") { say(`в ${dir} уже пишет сборщик (pid ${e.pid})`); process.exit(3); }
    throw e;
  }
  say(`сбор начат: ${dir}; ${assets.join(", ")} × ${tfs.join(", ")}; Ctrl+C — остановить`);
  let stopping = false;
  const stop = async (why) => {
    if (stopping) { say("повторный сигнал: выхожу сразу"); process.exit(1); }
    stopping = true;
    say(`${why}: закрываю файлы часа…`);
    try { await collector.stop(); say("остановлен"); process.exit(0); } catch (e) { say(`ошибка остановки: ${e.message}`); process.exit(1); }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("uncaughtException", (e) => { say(`сбой: ${e.stack || e.message}`); stop("сбой"); });
  process.on("unhandledRejection", (e) => { say(`сбой (promise): ${e && (e.stack || e.message)}`); });
  setInterval(() => {
    const s = collector.status();
    const feeds = Object.entries(s.feeds).map(([k, f]) => `${k} ${f.messages}${f.endpoint && f.endpoint !== "polymarket" ? `@${f.endpoint}` : ""}` +
      `${f.gap ? ` (нет данных ${sec(Date.now() - f.gap.from)})` : ""}${f.over ? ` пропусков > ${gapMs / 1000} с: ${f.over}` : ""}`).join(", ");
    say(`${feeds}; окон ${s.windows.windows}, токенов ${s.tokens}; ошибок записи ${s.store.errors}`);
  }, 5 * 60000).unref();
}

function printCheck(r) {
  const lines = [`Сбор за ${r.day} (${r.dir})`];
  lines.push(`Файлы: проверено ${r.files.checked}, строк ${r.files.lines.toLocaleString("ru-RU")}, ${mb(r.files.bytes)} сжато (${mb(r.files.raw)} без сжатия)` +
    `${r.files.open.length ? `; пишутся сейчас: ${r.files.open.length}` : ""}`);
  for (const [name, s] of Object.entries(r.streams).sort()) {
    lines.push(`  ${name.padEnd(15)} ${String(s.files).padStart(3)} ф.  ${s.lines.toLocaleString("ru-RU").padStart(12)} строк  ${mb(s.bytes).padStart(10)}  ${hm(s.first)}–${hm(s.last)}`);
  }
  if (Object.keys(r.endpoints).length) lines.push(`Источники: ${Object.entries(r.endpoints).map(([k, v]) => `${k} ${v.join("/")}`).join(", ")}`);
  const feeds = ["clob", "chainlink", "binance"];
  lines.push("Пропуски:");
  for (const f of feeds) {
    const g = r.gaps[f];
    if (!g) { lines.push(`  ${f.padEnd(10)} нет`); continue; }
    lines.push(`  ${f.padEnd(10)} ${g.n} (из них > ${r.gapMs / 1000} с: ${g.over}${g.filled ? `, восполнены историей: ${g.filled}` : ""}), всего ${sec(g.totalMs)}, ` +
      `самый длинный ${sec(g.maxMs)}; ${Object.entries(g.kinds).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    for (const x of g.longest.slice(0, 5)) {
      lines.push(`             ${hm(x.from)}–${hm(x.to)} ${x.kind} ${sec(x.ms)}${x.shard != null ? ` (соединение ${x.shard})` : ""}${x.filled ? " — восполнен" : ""}`);
    }
  }
  lines.push("Итоги окон, закончившихся за день (наш расчёт против официального):");
  const rules = Object.entries(r.outcomes.rules);
  if (!rules.length) lines.push("  окон нет");
  for (const [rule, s] of rules) {
    const extra = [];
    if (s.kAgree || s.kDiffer) extra.push(`старт = priceToBeat ${s.kAgree}/${s.kAgree + s.kDiffer}`);
    if (s.fAgree || s.fDiffer) extra.push(`итог = finalPrice ${s.fAgree}/${s.fAgree + s.fDiffer}`);
    lines.push(`  ${rule.padEnd(17)} совпали ${s.match}/${s.match + s.mismatch}${s.mismatch ? ` — РАСХОЖДЕНИЙ ${s.mismatch}` : ""}; нет данных ${s.no_data}, ждут итога ${s.pending}` +
      `${s.unsure ? `, неуверенных ${s.unsure}` : ""}${s.unknown ? `, правило неизвестно ${s.unknown}` : ""}${extra.length ? `; ${extra.join(", ")}` : ""}`);
  }
  for (const row of r.outcomes.rows.filter((x) => x.status === "mismatch" || (x.status === "match" && !x.sure)).slice(0, 20)) {
    lines.push(`  ${row.status === "mismatch" ? "≠" : "?"} ${row.slug}: наш ${row.ours}, официальный ${row.official}; старт ${row.k}, итог ${row.f}${row.note ? ` (${row.note})` : ""}`);
  }
  for (const p of r.problems.slice(0, 30)) lines.push(`  ОШИБКА ${p.file || ""} ${p.code}${p.detail != null ? `: ${p.detail}` : ""}`);
  lines.push(r.ok ? "Итог: OK" : `Итог: ЕСТЬ ОШИБКИ (${r.problems.length} в файлах, расхождений ${r.outcomes.rows.filter((x) => x.status === "mismatch").length})`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function status(dir, json) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, STATE), "utf8")); } catch {}
  if (!s) { process.stdout.write(json ? `${JSON.stringify({ ok: false, reason: "no_state" })}\n` : `В ${dir} сборщик ещё не запускался\n`); return 1; }
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(dir, LOCK), "utf8")); } catch {}
  const alive = (() => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } })();
  const fresh = !s.stopped && Date.now() - s.at < 30000;
  const running = alive && fresh;
  const stale = Object.entries(s.feeds || {}).filter(([, f]) => f.last == null || Date.now() - f.last > 60000).map(([k]) => k);
  const shards = (s.feeds && s.feeds.clob && s.feeds.clob.shards) || [];
  for (const x of shards) if (x.last == null || Date.now() - x.last > 60000) stale.push(`clob #${x.shard} (${x.series.join(", ")})`);
  let today = null;
  try { today = JSON.parse(fs.readFileSync(path.join(dir, utcDay(Date.now()), MANIFEST), "utf8")); } catch {}
  const out = { ok: running && !stale.length, running, pid: alive ? pid : null, at: s.at, started: s.started, stopped: s.stopped, stale, feeds: s.feeds,
    windows: s.windows, tokens: s.tokens, store: s.store, today: today ? { files: Object.keys(today.files).length, gaps: today.gaps.length,
      over5s: today.gaps.filter((g) => g.ms > 5000).length } : null };
  if (json) { process.stdout.write(`${JSON.stringify(out)}\n`); return out.ok ? 0 : 1; }
  const lines = [running ? `Сборщик работает (pid ${pid}), с ${new Date(s.started).toISOString()}` :
    `Сборщик не работает${s.stopped ? ` (остановлен ${new Date(s.stopped).toISOString()})` : ` (последний сигнал ${new Date(s.at).toISOString()})`}`];
  for (const [k, f] of Object.entries(s.feeds || {})) {
    lines.push(`  ${k.padEnd(10)} ${f.messages} сообщ.${f.endpoint ? ` @${f.endpoint}` : ""}; последнее ${f.last ? `${sec(Date.now() - f.last)} назад` : "—"}; пропусков ${f.gaps} (> 5 с: ${f.over})` +
      `${f.shards && f.shards.length > 1 ? `; соединений ${f.shards.length}, открыто ${f.shards.filter((x) => x.open).length}` : ""}`);
  }
  if (s.windows) lines.push(`  окон ${s.windows.windows}, серий ${s.windows.series}/${s.windows.seriesWanted}, токенов ${s.tokens}, ждут итога ${s.windows.waitingResult}; ошибок Gamma ${s.windows.errors}`);
  if (s.store) lines.push(`  ошибок записи ${s.store.errors}${s.store.lastError ? ` (${s.store.lastError})` : ""}`);
  if (today) lines.push(`  сегодня: файлов ${Object.keys(today.files).length}, пропусков ${today.gaps.length} (> 5 с: ${out.today.over5s})`);
  if (stale.length && running) lines.push(`  ВНИМАНИЕ: нет данных больше минуты: ${stale.join(", ")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return out.ok ? 0 : 1;
}

async function main() {
  const opt = args(process.argv.slice(2));
  const cmd = opt._[0] || "run";
  const dir = path.resolve(opt.dir || process.env.VESPERA_COLLECTOR_DIR || "collector-data");
  if (cmd === "run") return run(opt, dir);
  if (cmd === "check") {
    const report = await checkDay({ dir, day: dayArg(opt._[1]), gapMs: Number(opt["gap-ms"] || 5000) });
    if (opt.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else printCheck(report);
    process.exit(report.ok ? 0 : 1);
  }
  if (cmd === "status") process.exit(status(dir, !!opt.json));
  process.stderr.write("usage: collect.js [run|check [day]|status] [--dir path] [--assets btc,eth,sol,xrp] [--tfs 5m,15m,1h,4h,1d] [--json]\n");
  process.exit(2);
}

main().catch((e) => { say(`ошибка: ${e.stack || e.message}`); process.exit(1); });
