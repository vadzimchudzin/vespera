"use strict";

const fs = require("fs");
const path = require("path");
const { createService } = require("./service");

function serverConfig(env = process.env) {
  if (!env.VESPERA_DATA_DIR) throw new Error("VESPERA_DATA_DIR is required");
  let token = env.VESPERA_SERVER_TOKEN || "";
  if (!token && env.VESPERA_SERVER_TOKEN_FILE) {
    const file = path.resolve(env.VESPERA_SERVER_TOKEN_FILE);
    const stat = fs.statSync(file);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("token_file_permissions_invalid");
    token = fs.readFileSync(file, "utf8").trim();
  }
  if (Buffer.byteLength(token) < 32) throw new Error("VESPERA_SERVER_TOKEN must contain at least 32 bytes");
  const port = env.VESPERA_PORT == null ? 8787 : Number(env.VESPERA_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("VESPERA_PORT is invalid");
  const host = env.VESPERA_HOST || "127.0.0.1";
  return { userDataDir: path.resolve(env.VESPERA_DATA_DIR), token, port, host };
}

function start(env = process.env) {
  const config = serverConfig(env);
  const { host, port, ...serviceOptions } = config;
  const service = createService(serviceOptions);
  const shutdown = () => service.close().catch(() => { process.exitCode = 1; });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  service.server.once("close", () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  });
  service.server.listen(port, host);
  return service;
}

if (require.main === module) {
  try { start(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { start, serverConfig };
