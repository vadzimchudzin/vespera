"use strict";

const { backup } = require("./operations");

function args(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--") || !values[i + 1] || values[i + 1].startsWith("--")) throw new Error("usage: node scripts/operations-backup.js --data-dir DIR --token-file FILE --destination NEW_PRIVATE_DIR");
    result[key.slice(2)] = values[++i];
  }
  if (!result["data-dir"] || !result["token-file"] || !result.destination || Object.keys(result).length !== 3) throw new Error("usage: node scripts/operations-backup.js --data-dir DIR --token-file FILE --destination NEW_PRIVATE_DIR");
  return { dataDir: result["data-dir"], tokenFile: result["token-file"], destination: result.destination };
}

if (require.main === module) {
  try {
    const result = backup(args(process.argv.slice(2)));
    process.stdout.write(`Backup verified and written: ${result.destination} (${result.files} files)\n`);
  } catch (error) {
    process.stderr.write(`Backup refused: ${error.code || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { args };
