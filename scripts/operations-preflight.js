"use strict";

const { preflight } = require("./operations");

function parse(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--") || !values[i + 1] || values[i + 1].startsWith("--")) throw new Error("usage: node scripts/operations-preflight.js --data-dir DIR --token-file FILE [--health-url https://host/healthz]");
    result[key.slice(2)] = values[++i];
  }
  if (!result["data-dir"] || !result["token-file"] || Object.keys(result).some((key) => !["data-dir", "token-file", "health-url"].includes(key))) throw new Error("usage: node scripts/operations-preflight.js --data-dir DIR --token-file FILE [--health-url https://host/healthz]");
  return { dataDir: result["data-dir"], tokenFile: result["token-file"], healthUrl: result["health-url"] || "http://127.0.0.1:8787/healthz" };
}

if (require.main === module) {
  preflight(parse(process.argv.slice(2))).then((result) => {
    process.stdout.write(`Preflight passed: Node ${result.nodeMajor}, data permissions/disk, private token-file metadata, clock (${result.clockSource}), healthz protocol ${result.health.protocol}.\n`);
  }).catch((error) => {
    process.stderr.write(`Preflight failed: ${error.code || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parse };
