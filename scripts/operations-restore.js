"use strict";

const { restore } = require("./operations");

function args(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--")) throw new Error("invalid_argument");
    const name = key.slice(2);
    if (name === "isolated-validation") result[name] = true;
    else if (name === "executor-start") result[name] = values[++i] === "true";
    else {
      if (!values[i + 1] || values[i + 1].startsWith("--")) throw new Error("missing_argument_value");
      result[name] = values[++i];
    }
  }
  if (!result.backup || !result["data-dir"] || !result["token-file"] || Object.keys(result).length !== 5 ||
      result["isolated-validation"] !== true || result["executor-start"] !== false) {
    throw new Error("usage: node scripts/operations-restore.js --backup DIR --data-dir EMPTY_ISOLATED_DIR --token-file NEW_TOKEN_FILE --isolated-validation --executor-start=false");
  }
  return { backupDir: result.backup, dataDir: result["data-dir"], tokenFile: result["token-file"], isolatedValidation: true, executorStart: false };
}

if (require.main === module) {
  try {
    const result = restore(args(process.argv.slice(2)));
    process.stdout.write(`Restore copied to isolated targets only; executor was not started: ${result.dataDir}\n`);
  } catch (error) {
    process.stderr.write(`Restore refused: ${error.code || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { args };
