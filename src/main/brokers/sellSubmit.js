"use strict";

// Preparation and submission only. A successful POST is not a confirmed sale:
// the durable intent remains locked until venue trade evidence is confirmed.
const { buildOrder, signOrder, orderHash, signatureTypeFor } = require("./orderSigner");
const { planSell } = require("./sellPlan");
const fail = (reason, ambiguous = false) => ({ ok: false, reason, ambiguous });
async function submitSell(adapter, { tokenId, shares, onPrepared, isActive = () => true } = {}) {
  if (!adapter.hasL2() || !adapter.hasPrivateKey() || typeof onPrepared !== "function") return fail("sale_not_ready");
  let book, schedule;
  try {
    const r = await adapter.client.getOrderBook(tokenId);
    if (!r?.ok || !r.json) return fail("sale_book_unavailable");
    book = r.json;
    if (!book.market || typeof adapter.client.clobMarketInfo !== "function") return fail("sale_fee_unavailable");
    const info = await adapter.client.clobMarketInfo(book.market);
    if (!info?.ok || !info.json) return fail("sale_fee_unavailable");
    // An absent field is not proof that the venue charges no fee.
    if (!Object.prototype.hasOwnProperty.call(info.json, "fd")) return fail("sale_fee_unavailable");
    const fd = info.json.fd;
    if (fd === null) schedule = { feeRate: 0, feeExponent: 1 };
    else if (fd.r != null && fd.r !== "" && fd.e != null && fd.e !== "" && Number.isFinite(Number(fd.r)) && Number(fd.r) >= 0 && Number.isFinite(Number(fd.e)) && Number(fd.e) > 0)
      schedule = { feeRate: Number(fd.r), feeExponent: Number(fd.e) };
    else return fail("sale_fee_unavailable");
  } catch { return fail("sale_book_unavailable"); }
  const plan = planSell({ tokenId, shares, book });
  if (!plan.ok) return plan;
  if (!isActive()) return fail("sale_cancelled");
  let signed, evidence;
  try {
    adapter._syncClientIdentity();
    const walletType = adapter.resolvedWalletType();
    const order = buildOrder({ tokenId, makerAmount: plan.sharesMicro, takerAmount: plan.minimumProceedsMicro,
      maker: adapter.walletAddress, signer: walletType === "DEPOSIT_WALLET" ? adapter.walletAddress : adapter.signerAddress() || adapter.walletAddress,
      side: 1, signatureType: signatureTypeFor(walletType) });
    signed = await signOrder(order, adapter.privateKey, { negRisk: plan.negRisk });
    evidence = { orderId: orderHash(order, { negRisk: plan.negRisk }), maker: order.maker, tokenId: String(tokenId),
      shares: Number(plan.sharesMicro) / 1e6, limitPrice: Number(plan.limitPriceMicro) / 1e6, ...schedule };
    if (!isActive()) return fail("sale_cancelled");
    await onPrepared(evidence);
    if (!isActive()) return fail("sale_cancelled");
  } catch { return fail("sale_prepare_failed"); }
  try {
    // No automatic retry: a lost response or malformed response might hide a fill.
    const response = await adapter.client.postOrder({ ...signed, orderType: "FAK" });
    if (!response?.ok || !response.json || response.json.success === false) return fail("sale_outcome_unknown", true);
    const replyId = response.json.orderID || response.json.orderId;
    if (!replyId || String(replyId).toLowerCase() !== evidence.orderId.toLowerCase()) return fail("sale_outcome_unknown", true);
    return { ok: true, state: "submitted_unconfirmed", evidence, remainderMicro: plan.remainderMicro };
  } catch { return fail("sale_outcome_unknown", true); }
}
module.exports = { submitSell };
