"use strict";

const { monitorMetrics, readHealth } = require("./operations");

function parse(values, env = process.env) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--") || !values[i + 1] || values[i + 1].startsWith("--")) throw new Error("invalid_argument");
    result[key.slice(2)] = values[++i];
  }
  if (Object.keys(result).some((key) => !["data-dir", "health-url"].includes(key))) throw new Error("invalid_argument");
  const dataDir = result["data-dir"] || env.VESPERA_DATA_DIR;
  const healthUrl = result["health-url"] || env.VESPERA_HEALTH_URL || "http://127.0.0.1:8787/healthz";
  if (!dataDir || !healthUrl) throw new Error("VESPERA_DATA_DIR and health URL are required");
  return { dataDir, healthUrl };
}

async function run(options) {
  const metrics = monitorMetrics(options.dataDir);
  let health = { healthy: false };
  try { health = await readHealth(options.healthUrl); } catch { metrics.alerts.push("health_unavailable"); }
  const report = { at: new Date().toISOString(), health, metrics };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!health.healthy || metrics.alerts.length) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  try { run(parse(process.argv.slice(2))).catch((error) => { process.stderr.write(`monitor_failed: ${error.code || error.message}\n`); process.exitCode = 1; }); }
  catch (error) { process.stderr.write(`monitor_failed: ${error.code || error.message}\n`); process.exitCode = 1; }
}

module.exports = { parse, run };
