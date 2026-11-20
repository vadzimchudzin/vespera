"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SetupStore, SETUP_FIELDS, settingsFromEngine } = require("./setupStore");
const { Engine } = require("./engine");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "vespera-setups-")); }
function engineSettings() {
  const engine = new Engine({ userDataDir: dir(), settings: { timeframe: "4h" }, market: { bars: [], on() {}, start() {}, stop() {} }, live: { configure() {} } });
  try { return settingsFromEngine(engine); } finally { engine.dispose(); }
}

const settings = engineSettings();
assert.deepStrictEqual(Object.keys(settings).sort(), SETUP_FIELDS.slice().sort());
assert.equal(settings.timeframe, "4h", "paper setups retain a listed 4h timeframe");

const root = dir();
let store = new SetupStore(root);
const v1 = store.saveSetup({ name: "Pullback", settings });
assert.equal(v1.version, 1);
assert.equal(store.listSetups()[0].latestVersion, 1);
const changed = { ...settings, fastPeriod: 30 };
const v2 = store.saveSetup({ id: v1.id, name: "Pullback", settings: changed });
assert.equal(v2.version, 2);
assert.equal(store.getVersion(v1.id, 1).settings.fastPeriod, 20, "older versions never change");
assert.notEqual(v1.fingerprint, v2.fingerprint);
store.setActive({ id: v1.id, version: 1 });

const exported = store.exportSetup({ id: v1.id, version: 1 });
const imported = new SetupStore(dir());
const importedVersion = imported.importSetup({ json: exported.json });
assert.notEqual(importedVersion.id, v1.id, "portable imports receive new IDs");
assert.equal(importedVersion.fingerprint, v1.fingerprint);
const copied = imported.copySetup({ id: importedVersion.id, version: 1, name: "Copy" });
assert.equal(copied.version, 1);
assert.notEqual(copied.id, importedVersion.id);

assert.throws(() => store.importSetup({ json: JSON.stringify({ schemaVersion: 1, name: "bad", settings: { ...settings, privateKey: "secret" }, signalTimeframe: "4h", marketTimeframe: "4h" }) }), /invalid_setup/);
assert.throws(() => store.importSetup({ json: JSON.stringify({ schemaVersion: 1, name: "bad", settings, signalTimeframe: "4h", marketTimeframe: "1h" }) }), /timeframe_mismatch/);
assert.throws(() => store.saveSetup({ name: "bad", settings: { ...settings, symbol: "NOT-A-MARKET" } }), /unknown_symbol/);
assert.throws(() => store.saveSetup({ name: "bad", settings: { ...settings, mystery: 1 } }), /invalid_setup_field/);
assert.throws(() => store.saveSetup({ name: "bad", settings: { ...settings, strategyId: "unknown" } }), /unknown_strategy/);
assert.throws(() => store.saveSetup({ name: "bad", settings: { ...settings, signalTimeframe: "4h" } }), /invalid_setup_field/);
const { validateSetupSettings } = require("./setupStore");
assert.doesNotThrow(() => validateSetupSettings(settings, { mode: "auto" }), "verified BTC 4h setup is Auto-compatible");
assert.throws(() => validateSetupSettings({ ...settings, symbol: "DOGEUSDT" }, { mode: "auto" }), /market_unsupported_in_auto/);
assert.throws(() => store.importSetup({ json: " ".repeat(256 * 1024 + 1) }), /invalid_setup_import/);

store = new SetupStore(root);
assert.equal(store.value.activeSetup.version, 1, "active version persists across restart");
const conflicting = JSON.parse(JSON.stringify(store.value));
conflicting.setups[0].versions[0].name = "tampered";
const destination = new SetupStore(dir());
destination._write({ version: 1, setups: [{ ...store.value.setups[0], versions: [store.value.setups[0].versions[0]] }], activeSetup: null });
destination.importLibrary(store.value);
assert.equal(destination.getVersion(v1.id, 2).settings.fastPeriod, 30, "transfer merges append-only versions sharing identical history");
assert.throws(() => destination.importLibrary(conflicting), /setup_import_conflict/);
const wrongIdentity = structuredClone(store.value);
wrongIdentity.setups[0].versions[0].id = require("crypto").randomUUID();
assert.throws(() => store.importLibrary(wrongIdentity), /setup_store_corrupt/, "version identity must belong to its setup");
const beforeTooLarge = fs.readFileSync(store.file, "utf8");
const oversized = { version: 1, activeSetup: null, setups: Array.from({ length: 100 }, () => {
  const id = require("crypto").randomUUID();
  return { id, name: v1.name, versions: Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(v1), id, version: index + 1 })) };
}) };
assert.throws(() => store._write(oversized), /setup_limit/, "reject library above the readable file limit before replacing data");
assert.equal(fs.readFileSync(store.file, "utf8"), beforeTooLarge);
const corruptRoot = dir();
fs.writeFileSync(path.join(corruptRoot, "setups.json"), "{broken", { mode: 0o600 });
assert.throws(() => new SetupStore(corruptRoot), /setup_store_corrupt/);

// The library is editable: a setup can be renamed or removed, and its history still never changes.
const editable = new SetupStore(dir());
const kept = editable.saveSetup({ name: "Kept", settings });
editable.saveSetup({ id: kept.id, name: "Kept", settings: changed });
editable.setActive({ id: kept.id, version: 2 });
const renamed = editable.renameSetup({ id: kept.id, name: "Renamed" });
assert.deepStrictEqual([renamed.name, renamed.renamed], ["Renamed", true]);
assert.equal(editable.listSetups()[0].name, "Renamed");
assert.equal(editable.getVersion(kept.id, 2).name, "Renamed", "the newest version carries the setup name");
assert.equal(editable.getVersion(kept.id, 1).name, "Kept", "older versions keep the label they were saved with");
assert.equal(editable.getVersion(kept.id, 2).settings.fastPeriod, 30, "renaming never touches settings");
assert.equal(editable.renameSetup({ id: kept.id, name: "Renamed" }).renamed, false, "the same label is a no-op");
assert.throws(() => editable.renameSetup({ id: kept.id, name: "   " }), /invalid_setup_name/);
assert.throws(() => editable.renameSetup({ id: require("crypto").randomUUID(), name: "Nope" }), /setup_not_found/);
const other = editable.saveSetup({ name: "Other", settings });
const removed = editable.deleteSetup({ id: kept.id });
assert.deepStrictEqual([removed.name, removed.versions, removed.clearedActive], ["Renamed", 2, true]);
assert.equal(editable.listSetups().length, 1);
assert.equal(editable.value.activeSetup, null, "deleting the active setup clears the active reference");
assert.throws(() => editable.deleteSetup({ id: kept.id }), /setup_not_found/);
assert.equal(new SetupStore(editable.dir).listSetups().length, 1, "the removal is durable");
assert.equal(editable.deleteSetup({ id: other.id }).clearedActive, false, "removing a setup that is not active keeps the reference");
assert.equal(new SetupStore(editable.dir).value.activeSetup, null);

// A deletion travels with the library: a handoff cannot resurrect it.
{
  const desktop = new SetupStore(dir());
  const server = new SetupStore(dir());
  const kept = desktop.saveSetup({ name: "Desk", settings });
  const doomed = desktop.saveSetup({ name: "Doomed", settings });
  desktop.setActive({ id: doomed.id, version: 1 });
  // the other device gets the same library through a handoff
  server.importLibrary(structuredClone(desktop.value));
  assert.equal(server.listSetups().length, 2);

  desktop.deleteSetup({ id: doomed.id });
  assert.equal(desktop.value.deleted.length, 1, "the removal leaves a marker");
  server.importLibrary(structuredClone(desktop.value));
  assert.equal(server.listSetups().length, 1, "the merge drops what was deleted");
  assert.equal(server.listSetups()[0].id, kept.id);
  assert.equal(server.value.activeSetup, null, "an active reference to a deleted setup is cleared");

  // the deletion survives the other way round too
  desktop.importLibrary(structuredClone(server.value));
  assert.equal(desktop.listSetups().length, 1, "re-importing does not bring it back");

  // an explicit save over a deleted id is a decision to keep it
  const again = desktop.saveSetup({ id: doomed.id, name: "Doomed", settings });
  assert.equal(again.id, doomed.id);
  assert.equal(desktop.value.deleted.length, 0, "saving clears the marker");
  assert.equal(desktop.listSetups().length, 2);
}
console.log("setup store tests ok");
