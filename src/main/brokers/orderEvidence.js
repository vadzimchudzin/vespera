"use strict";

const { takerFee } = require("../fees");

const terminal = new Set(["MATCHED", "CANCELED", "CANCELLED", "CANCELED_MARKET_RESOLVED"]);
const statusOf = (value) => String(value || "").toUpperCase().replace(/^ORDER_STATUS_|^TRADE_STATUS_/, "");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const positive = (value) => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
const fail = (reason) => ({ ok: false, reason });

async function inspectOrder(client, pending, walletAddress) {
  const prepared = pending?.prepared || pending?.evidence;
  if (!prepared || !/^0x[a-f0-9]{64}$/i.test(prepared.orderId || "")) return fail("order_hash_unavailable");
  if (!same(prepared.maker, walletAddress) || !["UP", "DOWN"].includes(pending.side)) return fail("order_identity_mismatch");
  if (typeof client.getOrder !== "function" || typeof client.getTrade !== "function") return fail("reconciliation_unsupported");
  const response = await client.getOrder(prepared.orderId);
  if (!response?.ok || !response.json) return fail(response?.status === 404 ? "order_not_found_unproven" : "order_lookup_unavailable");
  const order = response.json;
  if (!same(order.id, prepared.orderId) || !same(order.maker_address, prepared.maker) ||
      String(order.asset_id) !== String(prepared.tokenId) || String(order.side).toUpperCase() !== "BUY") return fail("order_identity_mismatch");
  const status = statusOf(order.status);
  if (!terminal.has(status)) return fail("order_not_terminal");
  const matched = Number(order.size_matched);
  if (!positive(order.size_matched) || !Array.isArray(order.associate_trades) || !order.associate_trades.length) return fail("order_fill_unproven");
  const ids = [...new Set(order.associate_trades)];
  if (ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 200)) return fail("order_evidence_invalid");
  const exponent = Number(prepared.feeExponent);
  if (!positive(prepared.feeExponent)) return fail("order_fee_unproven");
  let shares = 0;
  let spent = 0;
  let fee = 0;
  for (const id of ids) {
    const result = await client.getTrade(id, prepared.maker);
    if (!result?.ok || !result.json) return fail("trade_lookup_unavailable");
    const rows = Array.isArray(result.json) ? result.json : result.json.data;
    if (!Array.isArray(rows)) return fail("trade_evidence_invalid");
    const matches = rows.filter((row) => row?.id === id);
    if (matches.length !== 1) return fail("trade_evidence_incomplete");
    const trade = matches[0];
    if (!same(trade.taker_order_id, prepared.orderId) || String(trade.asset_id) !== String(prepared.tokenId) ||
        String(trade.side).toUpperCase() !== "BUY" || String(trade.trader_side).toUpperCase() !== "TAKER") return fail("trade_identity_mismatch");
    if (statusOf(trade.status) !== "CONFIRMED") return fail("trade_not_final");
    const size = Number(trade.size);
    const price = Number(trade.price);
    if (!positive(trade.size) || !positive(trade.price) || price >= 1 || price > Number(prepared.limitPrice) + 1e-8) return fail("trade_amount_invalid");
    if (trade.fee_rate_bps == null || trade.fee_rate_bps === "" || !Number.isFinite(Number(trade.fee_rate_bps)) || Number(trade.fee_rate_bps) < 0) return fail("order_fee_unproven");
    const rate = Number(trade.fee_rate_bps) / 10000;
    if (!Number.isFinite(Number(prepared.feeRate)) || Math.abs(rate - Number(prepared.feeRate)) > 1e-8) return fail("order_fee_schedule_mismatch");
    shares += size;
    spent += size * price;
    fee += takerFee(size, price, { rate, exponent });
  }
  if (Math.abs(shares - matched) > 1e-6 || spent > Number(prepared.sizeUsd) + 1e-6 || !Number.isFinite(spent)) return fail("trade_evidence_incomplete");
  return {
    ok: true, kind: "filled",
    order: { side: pending.side, orderId: prepared.orderId, tokenId: prepared.tokenId, slug: prepared.slug,
      sizeUsd: spent.toFixed(6), price: spent / shares, entryPrice: spent / shares, shares, feeUsd: fee.toFixed(5),
      payout: shares / spent, filled: true, partial: spent < Number(prepared.sizeUsd) - 1e-6, orderStatus: status },
    evidence: { orderId: prepared.orderId, status, checkedAt: Date.now(), tradeIds: ids, feeSource: "confirmed_trades_and_saved_schedule" },
  };
}

module.exports = { inspectOrder };
