"use strict";

// Evidence for a SELL is deliberately separate from BUY reconciliation: a
// confirmed sale must never be reconstructed as a new entry after a restart.
const { takerFee } = require("../fees");
const terminal = new Set(["MATCHED", "CANCELED", "CANCELLED", "CANCELED_MARKET_RESOLVED"]);
const statusOf = (x) => String(x || "").toUpperCase().replace(/^ORDER_STATUS_|^TRADE_STATUS_/, "");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const positive = (x) => x != null && x !== "" && Number.isFinite(Number(x)) && Number(x) > 0;
const fail = (reason) => ({ ok: false, reason });

async function inspectSell(client, pending, walletAddress) {
  const p = pending?.evidence || pending?.prepared;
  if (pending?.action !== "SELL" || !p || !/^0x[a-f0-9]{64}$/i.test(p.orderId || "")) return fail("sell_hash_unavailable");
  if (!same(p.maker, walletAddress) || !p.tokenId || !positive(p.shares) || !positive(p.limitPrice) || Number(p.limitPrice) >= 1)
    return fail("sell_identity_invalid");
  if (typeof client.getOrder !== "function" || typeof client.getTrade !== "function") return fail("sell_inspection_unsupported");
  const response = await client.getOrder(p.orderId);
  if (!response?.ok || !response.json) return fail(response?.status === 404 ? "sell_not_found_unproven" : "sell_lookup_unavailable");
  const order = response.json;
  if (!same(order.id, p.orderId) || !same(order.maker_address, p.maker) || String(order.asset_id) !== String(p.tokenId) || String(order.side).toUpperCase() !== "SELL")
    return fail("sell_identity_mismatch");
  const status = statusOf(order.status);
  if (!terminal.has(status)) return fail("sell_not_terminal");
  const matched = Number(order.size_matched);
  if (!positive(order.size_matched) || !Array.isArray(order.associate_trades) || !order.associate_trades.length) return fail("sell_fill_unproven");
  const ids = [...new Set(order.associate_trades)];
  if (ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 200)) return fail("sell_evidence_invalid");
  if (!positive(p.feeExponent) || p.feeRate == null || p.feeRate === "" || !Number.isFinite(Number(p.feeRate)) || Number(p.feeRate) < 0) return fail("sell_fee_unproven");
  let shares = 0, proceeds = 0, fee = 0;
  for (const id of ids) {
    const result = await client.getTrade(id, p.maker);
    if (!result?.ok || !result.json) return fail("sell_trade_lookup_unavailable");
    const rows = Array.isArray(result.json) ? result.json : result.json.data;
    if (!Array.isArray(rows)) return fail("sell_trade_evidence_invalid");
    const matches = rows.filter((row) => row?.id === id);
    if (matches.length !== 1) return fail("sell_trade_evidence_incomplete");
    const trade = matches[0];
    if (!same(trade.taker_order_id, p.orderId) || String(trade.asset_id) !== String(p.tokenId) || String(trade.side).toUpperCase() !== "SELL" || String(trade.trader_side).toUpperCase() !== "TAKER")
      return fail("sell_trade_identity_mismatch");
    if (statusOf(trade.status) !== "CONFIRMED") return fail("sell_trade_not_final");
    const size = Number(trade.size), price = Number(trade.price);
    if (!positive(trade.size) || !positive(trade.price) || price >= 1 || price < Number(p.limitPrice) - 1e-8) return fail("sell_trade_amount_invalid");
    if (trade.fee_rate_bps == null || trade.fee_rate_bps === "" || !Number.isFinite(Number(trade.fee_rate_bps)) || Number(trade.fee_rate_bps) < 0)
      return fail("sell_fee_unproven");
    const rate = Number(trade.fee_rate_bps) / 10000;
    if (Math.abs(rate - Number(p.feeRate)) > 1e-8) return fail("sell_fee_schedule_mismatch");
    shares += size; proceeds += size * price; fee += takerFee(size, price, { rate, exponent: Number(p.feeExponent) });
  }
  if (Math.abs(shares - matched) > 1e-6 || shares > Number(p.shares) + 1e-6 || !Number.isFinite(proceeds)) return fail("sell_trade_evidence_incomplete");
  return { ok: true, kind: "sold", sale: { orderId: p.orderId, tokenId: String(p.tokenId), shares, proceedsUsd: proceeds.toFixed(6),
    price: proceeds / shares, feeUsd: fee.toFixed(5), partial: shares < Number(p.shares) - 1e-6 },
  evidence: { orderId: p.orderId, status, checkedAt: Date.now(), tradeIds: ids, feeSource: "confirmed_trades_and_saved_schedule" } };
}
module.exports = { inspectSell };
