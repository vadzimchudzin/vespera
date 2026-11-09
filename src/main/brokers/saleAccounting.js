"use strict";

// Calculate one confirmed sale against a position without mutating either.
// USD and shares use micro-units so a restart/retry cannot silently erase dust.
function units(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, part = ""] = text.split(".");
  const n = BigInt(whole) * 1000000n + BigInt(part.padEnd(6, "0"));
  return n <= 1000000000000000n ? n : null;
}
function decimal(n) { return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`; }
function signedMoney(n) {
  const negative = n < 0n;
  const v = negative ? -n : n;
  const cents = (v + 5000n) / 10000n;
  return `${negative && cents ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
function positionReady(bet) {
  const shares = units(bet?.shares), cost = units(bet?.sizeUsd), fee = units(bet?.feeUsd);
  const proceeds = units(bet?.saleProceedsUsd ?? "0"), sellFee = units(bet?.saleFeeUsd ?? "0");
  return Boolean(bet?.clientOrderId && bet?.tokenId && shares != null && shares > 0n && cost != null && cost > 0n && fee != null && proceeds != null && sellFee != null);
}
function applySale(bet, sale) {
  const remaining = units(bet?.shares), cost = units(bet?.sizeUsd), entryFee = units(bet?.feeUsd);
  const beforeProceeds = units(bet?.saleProceedsUsd ?? "0"), beforeFee = units(bet?.saleFeeUsd ?? "0");
  const sold = units(sale?.shares), proceeds = units(sale?.proceedsUsd), fee = units(sale?.feeUsd);
  if (!bet?.clientOrderId || !bet?.tokenId || !sale?.orderId || String(bet.tokenId) !== String(sale.tokenId) ||
      [remaining, cost, entryFee, beforeProceeds, beforeFee, sold, proceeds, fee].some(n => n === null) ||
      remaining <= 0n || sold <= 0n || sold > remaining || cost <= 0n || proceeds <= 0n || fee > proceeds) {
    return { ok: false, reason: "sale_accounting_invalid" };
  }
  const left = remaining - sold, totalProceeds = beforeProceeds + proceeds, totalFee = beforeFee + fee;
  if (left > 0n) return { ok: true, complete: false, bet: { ...bet, shares: decimal(left),
    saleProceedsUsd: decimal(totalProceeds), saleFeeUsd: decimal(totalFee) } };
  const pnl = totalProceeds - totalFee - cost - entryFee;
  return { ok: true, complete: true, settled: { ...bet, mode: "auto", dryRun: false,
    status: pnl >= 0n ? "win" : "loss", pnl: signedMoney(pnl), feeUsd: decimal(entryFee + totalFee),
    saleProceedsUsd: decimal(totalProceeds), saleFeeUsd: decimal(totalFee), settlementStatus: "final",
    settlementSource: "confirmed_market_sale", saleOrderId: sale.orderId, settledAt: Date.now() } };
}
module.exports = { applySale, positionReady };
