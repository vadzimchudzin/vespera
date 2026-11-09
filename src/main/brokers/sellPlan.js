"use strict";

// Prepare, but never submit, a bounded FAK sale. Amounts are exact 6-decimal
// integers; the held-token remainder is explicit and must not be marked sold.
const TICKS = new Map([["0.1", 100000n], ["0.01", 10000n], ["0.005", 5000n], ["0.0025", 2500n], ["0.001", 1000n], ["0.0001", 100n]]);
function micro(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const n = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0"));
  return n <= 1000000000000000n ? n : null;
}
function planSell({ tokenId, shares, book }) {
  if (!tokenId || !book || String(book.asset_id) !== String(tokenId)) return { ok: false, reason: "sale_book_identity" };
  const tickText = String(book.tick_size || "");
  const tick = TICKS.get(tickText);
  if (!tick || typeof book.neg_risk !== "boolean") return { ok: false, reason: "sale_market_metadata" };
  const held = micro(shares), minimum = micro(book.min_order_size);
  if (held == null || held <= 0n || minimum == null || minimum <= 0n) return { ok: false, reason: "sale_invalid_size" };
  const amount = held / 10000n * 10000n; // CLOB size precision = 2 decimals
  if (amount < minimum || amount === 0n) return { ok: false, reason: "sale_below_minimum" };
  if (!Array.isArray(book.bids)) return { ok: false, reason: "sale_book_missing" };
  const levels = [];
  for (const b of book.bids) {
    const price = micro(b?.price), size = micro(b?.size);
    if (price == null || size == null || price <= 0n || price >= 1000000n || size <= 0n || price % tick !== 0n)
      return { ok: false, reason: "sale_book_invalid" };
    levels.push({ price, size });
  }
  levels.sort((a, b) => a.price === b.price ? 0 : a.price > b.price ? -1 : 1);
  let volume = 0n, limit = null;
  for (const l of levels) { volume += l.size; if (volume >= amount) { limit = l.price; break; } }
  if (limit == null) return { ok: false, reason: "sale_insufficient_depth" };
  const product = amount * limit;
  if (product % 1000000n !== 0n) return { ok: false, reason: "sale_precision_invalid" };
  const proceeds = product / 1000000n;
  if (proceeds <= 0n) return { ok: false, reason: "sale_precision_invalid" };
  return { ok: true, tokenId: String(tokenId), sharesMicro: amount.toString(), remainderMicro: (held - amount).toString(),
    minimumProceedsMicro: proceeds.toString(), limitPriceMicro: limit.toString(), negRisk: book.neg_risk, orderType: "FAK" };
}
module.exports = { planSell };
