(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VesperaBalance = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /**
   * Which figure a screen shows as «Balance» — decided here once, for the window and for the Telegram bot.
   *
   *  - Paper: the virtual book.
   *  - Auto, dry run or live: what the Polymarket wallet holds. A dry run books its bets on a virtual book of its own;
   *    that is reported separately in `virtual` and never stands in for the wallet.
   *
   * A virtual number is never returned as the wallet balance. An engine that has not read the wallet yet (a restart, a
   * handoff, a new account) says "checking"; a wallet that cannot be read says "unavailable"; one that was read before
   * but not lately is "stale" and keeps its last value.
   *
   * @returns {{
   *   book: "paper"|"dry"|"live",        which money the session trades
   *   source: "paper"|"live",            where the figure comes from
   *   state: "ok"|"stale"|"checking"|"unavailable",
   *   value: string|null,                money as the engine formatted it, null when it is not known
   *   reason: string|null,               why it is stale or unavailable
   *   at: number|null,                   when the wallet last answered (ms), live only
   *   virtual: string|null,              dry run only: the balance of the virtual book
   * }}
   */
  function view(snap) {
    const s = snap && typeof snap === "object" ? snap : {};
    const paper = money(s.paper && s.paper.balance);
    const auto = s.mode === "auto";
    const book = !auto ? "paper" : s.book === "live" || s.book === "dry"
      ? s.book
      : s.settings && s.settings.dryRun === false ? "live" : "dry";
    const out = {
      book,
      source: auto ? "live" : "paper",
      state: "checking",
      value: null,
      reason: null,
      at: null,
      virtual: book === "dry" ? paper : null,
    };
    // In Zero Mode the book lives on the server; a snapshot that only stands in for it carries nobody's money.
    if (s.serverStateMissing) return { ...out, state: "unavailable", reason: "server_unreachable" };
    if (!s.mode) return out;
    if (!auto) {
      if (paper == null) return out;
      return { ...out, state: "ok", value: paper };
    }
    const live = s.liveBalance;
    if (!live || live.source !== "live") return out;
    const value = money(live.value);
    if (live.ok && value != null) {
      return { ...out, state: live.stale ? "stale" : "ok", value, reason: live.stale ? live.reason || null : null, at: Number(live.at) || null };
    }
    if (live.pulsing && live.reason === "checking") return out;
    return { ...out, state: "unavailable", reason: live.reason || "no_balance" };
  }

  function money(value) {
    if (value == null || value === "") return null;
    return Number.isFinite(Number(value)) ? String(value) : null;
  }

  return { view };
});
