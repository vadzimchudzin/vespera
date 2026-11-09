"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Engine } = require("./engine");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-sell-engine-"));
const market = () => ({ bars: [], on() {}, start() {}, stop() {} });
let step = 0, submitted = 0;
const ids = ["0x" + "a".repeat(64), "0x" + "b".repeat(64)];
const live = {
 async submitSale({ onPrepared }) { const i = step; submitted++; await onPrepared({ orderId: ids[i], maker: "wallet", tokenId: "123", shares: 10, limitPrice: 0.3, feeRate: 0.07, feeExponent: 1 }); return { ok: true, evidence: { orderId: ids[i] } }; },
 async inspectOrder(pending) { const i = ids.indexOf(pending.evidence.orderId); return { ok: true, kind: "sold", sale: { orderId: ids[i], tokenId: "123", shares: i ? "4" : "6", proceedsUsd: i ? "2.00" : "3.00", feeUsd: "0.10" }, evidence: { orderId: ids[i], status: "MATCHED" } }; },
 async getBalance() { return null; },
};
function engine() { return new Engine({ userDataDir: dir, settings: { mode: "auto", dryRun: false }, market: market(), live }); }
(async () => {
 let e = engine();
 const bet = { mode: "auto", dryRun: false, clientOrderId: "buy-1", side: "UP", tokenId: "123", shares: "10", sizeUsd: "4", feeUsd: "0.04", entryPrice: 0.4, slug: "market", placedAt: 1 };
 e.journal.write({ type: "order_sent", ...bet }); e.liveBet = { ...bet };
 let r = await e.closePositionForReset();
 assert.equal(r.ok, true); assert.equal(r.complete, false); assert.equal(e.liveBet.shares, "4.000000"); assert.equal(e.journal.pendingOrder(), null);
 e.dispose(); e = engine(); assert.equal(e.liveBet.shares, "4.000000", "partial sale restored after restart");
 assert.equal(e.liveBet.saleProceedsUsd, "3.000000");
 step = 1;
 const write = e.journal.write.bind(e.journal); let injected = false;
 e.journal.write = row => { const result = write(row); if (row.type === "settled" && !injected) { injected = true; throw Error("append failure after checkpoint"); } return result; };
 r = await e.closePositionForReset();
 assert.equal(r.ok, true); assert.equal(r.complete, true); assert.equal(e.liveBet, null); assert.equal(e.journal.pendingOrder(), null);
 const row = e.journal.restoreEntries.find(x => x.type === "settled");
 assert.equal(row.pnl, "0.76"); assert.equal(row.saleOrderId, ids[1]); assert.equal(submitted, 2);
 e.dispose(); e = engine(); assert.equal(e.liveBet, null); assert.equal(e.journal.restoreEntries.filter(x => x.type === "settled").length, 1);
 e.dispose();
 // A lost response must not place a second sale or settle the original bet.
 e = engine();
 const another = { ...bet, clientOrderId: "buy-unknown" };
 e.journal.write({ type: "order_sent", ...another }); e.liveBet = another;
 const originalSubmit = live.submitSale;
 live.submitSale = async ({ onPrepared }) => { submitted++; await onPrepared({ orderId: ids[0], maker: "wallet", tokenId: "123", shares: 10, limitPrice: 0.3, feeRate: 0.07, feeExponent: 1 }); return { ok: false, reason: "sale_outcome_unknown", ambiguous: true }; };
 r = await e.closePositionForReset(); assert.equal(r.reason, "sale_outcome_unknown");
 assert.equal(e._settleLive({ closeTs: Date.now(), close: 10 }), null, "settlement is blocked while a sale is unknown");
 const before = submitted;
 assert.equal((await e.closePositionForReset()).reason, "order_pending"); assert.equal(submitted, before, "no duplicate post");
 e.dispose(); e = engine(); assert.equal(e.journal.pendingOrder().action, "SELL"); assert.equal(e.liveBet.clientOrderId, "buy-unknown");
 live.submitSale = originalSubmit; e.dispose();
 console.log("Sale engine tests ok");
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
