# Pre-registered: Polymarket liquidity-reward LP (paper), frozen 2026-11-05 01:10 UTC
Forward paper sim lp/paper_lp2.js on the universe lp/paper2/universe.json (2460 reward markets, non-sports, >=3 days to end,
mid 0.1-0.9, spread <= 2v, rate >= $5/day), chosen from the 00:35 UTC snapshot. No orders are ever sent.
Variants: n = naive (cutoff mid -/+ v/3); a = robust fair value (median of last 5 raw mids) -/+ v/3; b = robust -/+ 0.6v;
c = a + 10-min volatility filter + inventory skew. 50 shares (or min size) per side, inventory cap 4x size, re-quote each minute.
Fills: any RTDS taker trade at or through our price, plus the real book crossing our resting quote at the next poll.
Rewards: Polymarket formula per minute; share vs competitors from the live book (agg = per-side min/3 rule; pess = sum of both sides).
Report: rewards, mark-to-market P&L (robust fair value), net = rewards + MTM, per variant; per-market dispersion.
Pass criterion: net (pess rewards) > 0 for a robust variant over >= 24 h, and no single market > 25% of the P&L.

## Addendum A (frozen 2026-11-05 01:40 UTC, before any paper4 result): fast re-quote on a small high-return universe
lp/paper_lp4.js = paper_lp3.js model, re-quoting every 10 s (reward sample weight rate/8640 per poll; robust fair value = median of
the last 6 raw mids ~1 min; volatility filter = 10-min span > v). Universe lp/paper4/universe.json = top 300 markets of the frozen
paper2 universe by roc0 from the 00:35 snapshot (no live data used). Variants: g = robust fv -/+ v/3 + vol filter + skew (like c);
h = centered on scoring mid when |mid-fv| <= 0.25v, k = 1/3, vol filter + skew (like d). Comparison: same 300 markets in paper2 (c)
and paper3 (d) over the same period, to isolate the effect of re-quote speed. Same pass criterion (>= 24 h, net pess > 0, no market > 25%).

## Addendum B (frozen 2026-11-05 02:08 UTC): 3 s re-quote
Motivation (from the first 30 min, same 300 markets): 60 s re-quote variants net ~0 (MTM losses mostly from stale quotes
crossed by the book), 10 s variants net positive. lp/paper5 = paper_lp4.js with POLL_MS=3000 on the same paper4 universe,
variants g and h unchanged (robust median over ~1 min, 10-min vol filter). Same pass criterion.

## Addendum C (frozen 2026-11-05 16:16 UTC, at the start of the run): news shield
- Variant `hs` = `h` + shield. Shock = an RTDS taker trade in the market at >= 0.5*v from the last scoring mid, or one-sided
  taker volume >= 3x our quote size within 30 s. On a shock: pull our quotes in that market and in every universe market of
  the same event, effective 250 ms later (trades inside 250 ms still fill), no quotes and no rewards for 5 min.
- Run: 3 s re-quote, fresh top-300 universe (built 16:15 UTC), variants g, h, hs side by side.
- Hypothesis: hs net (pessimistic rewards + MTM) per day > h on the same markets. Test after >= 24 h: paired difference
  by market, t > 2, and hs net > 0. Report shocks per day, share of time pulled and rewards given up.

## Desk addendum (frozen 2026-11-05 21:56 UTC, before the desk's run; Vespera 0.28.0, agent a10)
How the agents desk runs and reads this plan with Addendum C. The pass criterion and the shield hypothesis are
unchanged; this fixes what the plan left open.
- The lane is variant `hs` (`h` + the shield of Addendum C). Variant `h` runs as a shadow fed the same books and RTDS
  trades, without the shield; `g` is not run.
- Account: a separate V2 paper account of $20 000 with at most $200 a market: up to 300 markets by expected reward per
  dollar under the research filters (rate >= $5/day, no sports, >= 3 days to the end, mid 0.10-0.90, raw spread <= 2v),
  50 shares a side or the market's reward minimum if larger (a minimum above 200 is skipped). Its P&L stays out of the
  desk's equity and halts; no day stop.
- Re-quote every 10 s (Addendum A's cadence), not the 3 s of the Addendum C run: the desk polls the books of up to 300
  markets from the user's machine.
- Hours: lane time in which the books arrived and the RTDS trade feed was live (a message within 60 s). Phase 1 closes
  at 24 such hours and the universe is rebuilt at once; phase 2 closes after 24 more. The 6-hourly rebuilds go on in
  both phases; a market with inventory stays until it is flat, a resolved one is settled at its result.
- Phase 2 counts what each market made after phase 1 closed; a market that made nothing since (it left at the rebuild)
  is not in phase 2.
- Pass: in each phase net (pessimistic rewards + MTM) > 0 and no market > 25% of it; a failed phase 1 fails the test.
  The shield test (paired difference hs - h by market, t > 2, and hs net > 0) is read once, on phase 1. Shocks per day,
  the share of market time pulled and the rewards given up are reported.
- The sample starts when the lane first runs on 0.28.0 and survives restarts (saved state). "Start V2 afresh" starts it
  over; each such restart is a new run in REGISTRY.md. The technical checks before the release (2026-11-05 21:25 and
  21:52 UTC, throwaway data folders) are not part of any sample.
