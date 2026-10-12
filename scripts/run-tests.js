"use strict";

/**
 * Runs every test file in its own process with a clean network environment: system proxies and
 * NODE_USE_ENV_PROXY would otherwise send the tests' loopback requests through a proxy and fail them.
 * Usage: npm test            (all files)
 *        node scripts/run-tests.js strategy engine   (only files whose path contains a word)
 */
const { spawnSync } = require("child_process");
const path = require("path");
const pkg = require("../package.json");

const root = path.join(__dirname, "..");
const files = [];
for (const key of ["test:core", "test:setups", "test:extra"]) {
  const script = pkg.scripts[key] || "";
  for (const part of script.split("&&")) {
    const match = /^\s*node\s+(\S+)\s*$/.exec(part);
    if (match && !files.includes(match[1])) files.push(match[1]);
  }
}
const filters = process.argv.slice(2);
const selected = filters.length ? files.filter((file) => filters.some((word) => file.includes(word))) : files;

const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete env[key];

const failed = [];
const started = Date.now();
for (const file of selected) {
  const begin = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, file)], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
  const ok = result.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${file} (${((Date.now() - begin) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failed.push(file);
    const out = `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n").slice(-25).join("\n");
    console.log(out.replace(/^/gm, "     | "));
  }
}
console.log(`\n${selected.length - failed.length}/${selected.length} test files passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
