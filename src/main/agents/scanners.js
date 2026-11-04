"use strict";

// Where the agents look. Each scanner first screens the catalog on Gamma's best bid/ask (cheap, possibly stale),
// then the desk confirms the survivors on fresh order books and sizes them. Pure functions: no network, no clock.

const { takerFee } = require("../fees");
const { walkCost, simulateBuy } = require("./paper");
const { mirror } = require("./market");
const { kellyStake, limitName } = require("./risk");
const M = require("./models");

const SKIP_TITLE = /\bup or down\b/i;
// A rung pair priced more than 10¢ apart is a misread question or a stale quote far more often than a gift.
const MAX_LADDER_GAP = 0.1;
// The model agents never buy a side priced under 3¢: the market is ≥ 97% sure of the other side, usually because
// the deciding fact is already known to it (a model that disagrees is more likely missing data than right).
const MIN_SIDE_PRICE = 0.03;
// A single-market buy needs a book it could leave: a bid on its side, a spread of at most a fifth of the ask, a fill
// at most 10% (at least 1¢) above the best ask, and shares worth at least 80% of their price at the bid right after.
// A thin book turns the spread into an instant loss that the model's edge has to win back first.
const BOOK = Object.freeze({ maxSpreadShare: 0.2, walkShare: 0.1, minWalk: 0.01, maxEntryLoss: 0.2 });
// Weather: the model is one forecast against a market that sees many; its probability counts 40% against the book's
// mid, and a gap over 25 points is taken for a model error. Buckets the observations already settle are exempt.
const WEATHER = Object.freeze({ weight: 0.4, maxGap: 0.25 });
const sidePrice = (m, side) => (side === "yes" ? m.ask : m.bid > 0 ? 1 - m.bid : null);
const clampP = (p) => Math.min(0.99, Math.max(0.01, p));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const c3 = (x) => Number(x).toFixed(3);
const feeShare = (price, fee) => takerFee(1, price, fee);
const endOf = (ev, m) => m.endDate || ev.endDate || null;
const isModelEvent = (ev) => Boolean(M.parseCryptoEvent(ev.title) || M.parseWeatherEvent(ev));

// --- arbitrage --------------------------------------------------------------------------------------------------
// negRisk events: exactly one market resolves YES. All YES cost less than $1, or all NO less than N − 1.
function screenBundles(events, { arbMinPct }) {
  const out = [];
  for (const ev of events) {
    if (!ev.negRisk || ev.augmented) continue;
    if (ev.markets.some((m) => m.closed && (m.price ?? 0) > 0.5)) continue;   // a winner is already known
    const open = ev.markets.filter((m) => !m.closed);
    if (open.length < 2 || open.some((m) => !m.accepting)) continue;
    const loose = 1 - 0.5 * arbMinPct / 100;
    if (open.every((m) => m.ask > 0 && m.ask < 1)) {
      const sum = open.reduce((s, m) => s + m.ask, 0);
      if (sum < loose) out.push({ key: `bundle:yes:${ev.id}`, type: "arb_bundle", event: ev, payout: 1, hint: 1 - sum, label: `${open.length} × YES`, legs: open.map((m) => ({ market: m, side: "yes" })) });
    }
    if (open.every((m) => m.bid > 0 && m.bid < 1)) {
      const sum = open.reduce((s, m) => s + (1 - m.bid), 0);
      const payout = open.length - 1;
      if (sum < payout * loose) out.push({ key: `bundle:no:${ev.id}`, type: "arb_bundle", event: ev, payout, hint: (payout - sum) / payout, label: `${open.length} × NO`, legs: open.map((m) => ({ market: m, side: "no" })) });
    }
  }
  return out.sort((a, b) => b.hint - a.hint).slice(0, 12);
}

// Within one non-negRisk event, markets that include one another: "by March" ⊂ "by June", "above 74k" ⊂ "above 72k",
// "hits ↑100k" ⊂ "hits ↑97.5k". If A ⊂ B, YES on B plus NO on A pays at least $1 whatever happens.
// A deadline counts only with its year written out ("by March 31, 2027?"): a label alone ("March 31") is ambiguous
// in an event that spans a new year, and a wrong year turns the pair upside down.
const DEADLINE = /\bby\s+([a-z]+\s+\d{1,2},?\s+\d{4})\b/i;
function deadlineOf(m) {
  const hit = DEADLINE.exec(m.question || "") || DEADLINE.exec(`by ${m.label || ""}`);
  return hit ? M.parseDateLabel(hit[1], null) : null;
}
function ladderKey(ev, m) {
  const text = `${ev.title} ${m.question}`.toLowerCase();
  if (/\bby\b|^when will/.test(text) && M.parseDateLabel(m.label, null)) {   // the rung is a date
    const at = deadlineOf(m);
    return at ? { family: "date", order: at, superset: "later" } : null;   // no year written: not a rung
  }
  const s = M.parseStrike(m.label);
  if (!s) return null;
  if (s.dir === "up" && s.k) return { family: "up", order: s.k, superset: "lower" };
  if (s.dir === "down" && s.k) return { family: "down", order: s.k, superset: "higher" };
  if (s.k && /\babove\b/.test(text)) return { family: "above", order: s.k, superset: "lower" };
  return null;
}
function screenLadders(events, { arbMinPct }) {
  const out = [];
  for (const ev of events) {
    if (ev.negRisk || SKIP_TITLE.test(ev.title)) continue;
    const rows = ev.markets.filter((m) => m.accepting && !m.closed).map((m) => ({ m, k: ladderKey(ev, m) })).filter((x) => x.k);
    for (const a of rows) for (const b of rows) {
      if (a === b || a.k.family !== b.k.family || a.k.order === b.k.order) continue;
      const subset = a.k.superset === "lower" ? a.k.order > b.k.order : a.k.order < b.k.order;   // a ⊂ b
      if (!subset || !(a.m.bid > 0) || !(b.m.ask > 0)) continue;
      const gap = a.m.bid - b.m.ask;
      if (gap > 0.5 * arbMinPct / 100 && gap <= MAX_LADDER_GAP) {
        out.push({ key: `ladder:${a.m.id}:${b.m.id}`, type: "arb_ladder", event: ev, payout: 1, hint: gap, label: `YES ${b.m.label} + NO ${a.m.label}`,
          legs: [{ market: b.m, side: "yes" }, { market: a.m, side: "no" }] });
      }
    }
  }
  return out.sort((x, y) => y.hint - x.hint).slice(0, 12);
}

// Size of a multi-leg arbitrage on real books: the largest profit with margin ≥ arbMinPct and profit ≥ arbMinUsd,
// within the dollar capacity and the per-market limit per leg. Profit is concave and piecewise linear in the size,
// so the best size is a level boundary or the capacity itself.
function sizeArbitrage(legs, payout, { arbMinPct, arbMinUsd }, cap) {
  const depth = Math.min(...legs.map((l) => l.asks.reduce((s, [, z]) => s + z, 0)));
  const minQ = Math.max(1, ...legs.map((l) => l.minSize || 0));
  if (!(depth >= minQ)) return null;
  const evalQ = (q) => {
    let cost = 0, fees = 0, maxLeg = 0;
    for (const l of legs) {
      const r = walkCost(l.asks, q, l.fee);
      if (!r) return null;
      cost += r.cost; fees += r.fees; maxLeg = Math.max(maxLeg, r.cost + r.fees);
    }
    return { q, cost, fees, total: cost + fees, maxLeg, profit: q * payout - cost - fees };
  };
  const fits = (r) => r && r.total <= cap.usd + 1e-9 && r.maxLeg <= cap.legUsd + 1e-9;
  if (!fits(evalQ(minQ))) return null;
  let lo = minQ, hi = depth;
  if (fits(evalQ(hi))) lo = hi;   // the whole depth fits: no search
  for (let i = 0; i < 40 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (fits(evalQ(mid))) lo = mid; else hi = mid;
  }
  const qMax = Math.max(minQ, Math.floor(lo * 100) / 100);
  const points = new Set([minQ, qMax]);
  for (const l of legs) {
    let cum = 0;
    for (const [, s] of l.asks) { cum += s; if (cum > minQ && cum < qMax) points.add(Math.floor(cum * 100) / 100); }
  }
  let best = null;
  for (const q of points) {
    const r = evalQ(q);
    if (!fits(r)) continue;
    if (r.profit / r.total >= arbMinPct / 100 && r.profit >= arbMinUsd && (!best || r.profit > best.profit)) best = r;
  }
  return best;
}

function confirmArbitrage(c, books, config, cap, say) {
  const legs = [];
  for (const leg of c.legs) {
    const book = books.get(leg.market.yes);
    if (!book) return { skip: say("нет стакана", "no book") };
    const side = leg.side === "yes" ? book : mirror(book);
    if (!side.asks.length) return { skip: say("пустой стакан", "empty book") };
    legs.push({ leg, asks: side.asks, fee: leg.market.fee, minSize: book.minSize });
  }
  const best = sizeArbitrage(legs, c.payout, config, cap);
  if (!best) return { skip: say(`на стаканах перевес < ${config.arbMinPct}% или < $${config.arbMinUsd} (лимит «${limitName(cap.binding)}»)`, `on the books the margin is < ${config.arbMinPct}% or < $${config.arbMinUsd} (limit "${limitName(cap.binding, true)}")`) };
  const orders = legs.map((l) => ({ market: l.leg.market, side: l.leg.side, fill: simulateBuy(l.asks, { shares: best.q, fee: l.fee, minSize: l.minSize }) }));
  if (orders.some((o) => !o.fill || Math.abs(o.fill.shares - best.q) > 0.005)) return { skip: say("нога не исполняется целиком", "a leg does not fill in full") };
  const why = say(
    `${legs.length} ног × ${best.q} ш: стоимость $${best.total.toFixed(2)} (комиссии $${best.fees.toFixed(2)}), гарантированная выплата $${(best.q * c.payout).toFixed(2)} → +$${best.profit.toFixed(2)} (${pct(best.profit / best.total)})`,
    `${legs.length} legs × ${best.q} sh: cost $${best.total.toFixed(2)} (fees $${best.fees.toFixed(2)}), guaranteed payout $${(best.q * c.payout).toFixed(2)} → +$${best.profit.toFixed(2)} (${pct(best.profit / best.total)})`);
  return { orders, prob: 1, edge: best.profit / best.total, costUsd: best.total, profitUsd: best.profit, why };
}

// --- single-leg model and AI trades -------------------------------------------------------------------------------
// One side of one market with a probability for the side bought. The edge is p − (best ask + fee per share); the
// stake is a quarter-Kelly of the agent's capital within the limits; the book is walked only while the edge holds.
function confirmSingle(c, books, { cap, prob, minEdge, fraction, bankroll, say }) {
  const book = books.get(c.market.yes);
  if (!book) return { skip: say("нет стакана", "no book") };
  const side = c.side === "yes" ? book : mirror(book);
  const best = side.asks[0];
  if (!best) return { skip: say("нет предложений", "no asks") };
  const p = typeof prob === "function" ? prob(best[0]) : prob;
  const fs = feeShare(best[0], c.market.fee);
  const cost = best[0] + fs;
  const edge = p - cost;
  if (!(edge >= minEdge)) return { skip: say(`перевес ${pct(edge)} < ${pct(minEdge)}`, `edge ${pct(edge)} < ${pct(minEdge)}`), edge };
  const bid = side.bids[0] ? side.bids[0][0] : 0;
  if (!(bid > 0)) return { skip: say("на этой стороне нет покупателей: продать будет некому", "no bids on this side: nobody to sell to"), edge };
  if (best[0] - bid > BOOK.maxSpreadShare * best[0] + 1e-9) {
    return { skip: say(`спред ${c3(bid)}–${c3(best[0])} шире 20% цены`, `spread ${c3(bid)}–${c3(best[0])} is wider than 20% of the price`), edge };
  }
  const kelly = kellyStake({ p, cost, bankroll, fraction });
  const stake = Math.min(kelly, cap.usd);
  const kl = fraction === 0.25 ? "¼" : fraction === 0.5 ? "½" : `${fraction}×`;
  if (stake < 1) return { skip: kelly < cap.usd ? say(`${kl}-Келли $${kelly.toFixed(2)} < $1`, `${kl}-Kelly $${kelly.toFixed(2)} < $1`) : say(`лимит «${limitName(cap.binding)}» исчерпан`, `limit "${limitName(cap.binding, true)}" used up`), edge };
  const limit = Math.min(0.999, p - minEdge - fs, best[0] + Math.max(BOOK.minWalk, BOOK.walkShare * best[0]));
  const fill = simulateBuy(side.asks, { budgetUsd: stake, limit, fee: c.market.fee, minSize: book.minSize });
  if (!fill) return { skip: say("меньше минимального размера стакана", "below the book's minimum size"), edge };
  if ((fill.avg - bid) / fill.avg > BOOK.maxEntryLoss + 1e-9) {
    return { skip: say(`вход по ${c3(fill.avg)} при покупателе ${c3(bid)}: сразу −${pct(1 - bid / fill.avg)}`,
      `entry at ${c3(fill.avg)} with the bid at ${c3(bid)}: −${pct(1 - bid / fill.avg)} at once`), edge };
  }
  const sideMid = side.bids[0] ? (side.bids[0][0] + best[0]) / 2 : best[0];
  const why = say(
    `p=${c3(p)} против ${c3(best[0])}+комиссия ${c3(fs)} → перевес ${pct(edge)}; ${kl}-Келли $${kelly.toFixed(2)}, лимит «${limitName(cap.binding)}» $${cap.usd.toFixed(2)} → $${(fill.cost + fill.fees).toFixed(2)}`,
    `p=${c3(p)} vs ${c3(best[0])}+fee ${c3(fs)} → edge ${pct(edge)}; ${kl}-Kelly $${kelly.toFixed(2)}, limit "${limitName(cap.binding, true)}" $${cap.usd.toFixed(2)} → $${(fill.cost + fill.fees).toFixed(2)}`);
  return { orders: [{ market: c.market, side: c.side, fill }], prob: p, marketProb: sideMid, edge, costUsd: fill.cost + fill.fees, why };
}

// Edge of a probability against Gamma's quotes, for the screen; the better side or null.
function quoteEdge(m, p) {
  const yes = m.ask > 0 && m.ask < 1 ? p - (m.ask + feeShare(m.ask, m.fee)) : -1;
  const no = m.bid > 0 && m.bid < 1 ? (1 - p) - ((1 - m.bid) + feeShare(1 - m.bid, m.fee)) : -1;
  return yes >= no ? { side: "yes", edge: yes, prob: p } : { side: "no", edge: no, prob: 1 - p };
}

// Favourites priced 90–98¢ that resolve within days: the favourite-longshot bias says they win a little more often
// than their price. A paper hypothesis with a small edge assumption (`bias`), sized by the same Kelly rule.
function screenFavorites(events, params, now) {
  const out = [];
  for (const ev of events) {
    if (SKIP_TITLE.test(ev.title) || isModelEvent(ev)) continue;
    for (const m of ev.markets) {
      if (!m.accepting || m.closed || m.liquidity < 2000) continue;
      const end = endOf(ev, m);
      if (!end || end < now + 3600000 || end > now + params.maxDays * 86400000) continue;
      if (m.ask != null && m.bid != null && m.ask - m.bid > 0.03) continue;
      if (m.ask >= params.minPrice && m.ask <= params.maxPrice) out.push({ key: `fav:${m.id}:yes`, type: "favorites", event: ev, market: m, side: "yes", hint: end });
      const noAsk = m.bid > 0 ? 1 - m.bid : null;
      if (noAsk != null && noAsk >= params.minPrice && noAsk <= params.maxPrice) out.push({ key: `fav:${m.id}:no`, type: "favorites", event: ev, market: m, side: "no", hint: end });
    }
  }
  return out.sort((a, b) => a.hint - b.hint).slice(0, 15);
}

// Weather: model probabilities per bucket (see models.weatherProbabilities); the better side of each bucket.
function weatherBlend(p, mid) { return mid + WEATHER.weight * (p - mid); }

function screenWeather(models, minEdge) {
  const out = [];
  for (const { event, result, info } of models) {
    const rows = [];
    for (const { market, p, decided } of result.buckets) {
      if (!market.accepting || market.closed) continue;
      const mid = market.bid > 0 && market.ask > 0 && market.ask < 1 ? (market.bid + market.ask) / 2 : null;
      if (!decided && (mid == null || Math.abs(p - mid) > WEATHER.maxGap)) continue;   // a model this far from the market is the likelier one to be wrong
      const use = decided ? p : weatherBlend(p, mid);
      const q = quoteEdge(market, clampP(use));
      const shrink = decided ? null : { p: clampP(p), w: WEATHER.weight, maxGap: WEATHER.maxGap };
      if (q.edge >= 0.5 * minEdge && sidePrice(market, q.side) >= MIN_SIDE_PRICE) rows.push({ key: `wx:${market.id}:${q.side}`, type: "weather", event, market, side: q.side, prob: q.prob, hint: q.edge, shrink,
        model: `${info.kind === "max" ? "max" : "min"} ${info.icao} ${info.date}: obs ${result.observed ?? "—"}, bias ${result.bias.toFixed(1)}, σ ${result.sigma.toFixed(2)}, ${result.members} members, ` +
          (decided ? `p=${c3(p)} by observation` : `model ${c3(p)} → ${c3(use)} with the market ${c3(mid)}`) });
    }
    out.push(...rows.sort((a, b) => b.hint - a.hint).slice(0, 2));
  }
  return out.sort((a, b) => b.hint - a.hint).slice(0, 12);
}

// Crypto price levels: P(above K at T), P(lo ≤ S_T < hi), P(touch K before T) under a driftless lognormal price.
// One volatility misprices a whole ladder: the next hours move more than a 30-day index says and the tails are fatter
// than lognormal, so a model on DVOL alone sees false edges against every wing. Each market is priced instead with the
// σ of its neighbours on the same ladder (up to two strikes each side quoted 5–95¢, least absolute deviations): the
// screen looks for a strike out of line with the strikes around it, not for a view on volatility. Left alone: the ends
// of a ladder, neighbours of which any one is over 3¢ off their common σ, and the last two hours before the close.
const MIN_CRYPTO_TAU = 2 * 3600000;
const SIGMA_GRID = 90;
const sigmaAt = (i) => 0.1 * Math.pow(50, i / SIGMA_GRID);   // 0.1 … 5, steps of 4.4%
// The σ that best reproduces the mids of `points` ({ prob(σ), mid }) and the largest miss; NaN at the grid's edge.
function ladderSigma(points) {
  if (!points.length) return null;
  const err = (sg) => points.reduce((e, pt) => { const p = pt.prob(sg); return e + (p == null ? 1 : Math.abs(p - pt.mid)); }, 0);
  let bi = 0, be = Infinity;
  for (let i = 0; i <= SIGMA_GRID; i++) { const e = err(sigmaAt(i)); if (e < be) { be = e; bi = i; } }
  if (bi === 0 || bi === SIGMA_GRID) return { sigma: NaN, worst: Infinity };
  let lo = sigmaAt(bi - 1), hi = sigmaAt(bi + 1);
  for (let k = 0; k < 40; k++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (err(a) <= err(b)) hi = b; else lo = a;
  }
  const sigma = (lo + hi) / 2;
  return { sigma, worst: Math.max(...points.map((pt) => { const p = pt.prob(sigma); return p == null ? 1 : Math.abs(p - pt.mid); })) };
}
// The event's markets as ladders: by strike, a touch ladder per direction.
function cryptoLadders(ev, info, d, now) {
  const ext = d.extremes && d.extremes[ev.id];
  const ladders = new Map();
  for (const m of ev.markets) {
    if (!m.accepting || m.closed) continue;
    const tau = endOf(ev, m) - now;
    if (!(tau >= MIN_CRYPTO_TAU)) continue;
    const s = M.parseStrike(m.label);
    if (!s) continue;
    let prob = null, x = 0;
    if (info.kind === "above" && s.k && s.dir == null) { prob = (sg) => M.probAbove(d.spot, s.k, sg, tau); x = s.k; }
    else if (info.kind === "range" && (s.lo || s.hi)) { prob = (sg) => M.probBetween(d.spot, s.lo, s.hi, sg, tau); x = s.lo || 0; }
    else if (info.kind === "touch" && s.dir && s.k) {
      if (!ext || (s.dir === "up" ? ext.high >= s.k * 0.997 : ext.low <= s.k * 1.003)) continue;   // reached or too close to tell
      prob = (sg) => M.probTouch(d.spot, s.k, sg, tau);
      x = s.k;
    }
    if (!prob) continue;
    const mid = m.bid > 0 && m.ask > 0 && m.ask - m.bid <= 0.1 ? (m.bid + m.ask) / 2 : null;
    const key = s.dir || "";
    if (!ladders.has(key)) ladders.set(key, []);
    ladders.get(key).push({ m, tau, prob, mid, x });
  }
  return [...ladders.values()].map((rows) => rows.sort((a, b) => a.x - b.x));
}
function screenCrypto(events, data, now, minEdge) {
  const out = [];
  const quoted = (r) => r.mid != null && r.mid >= 0.05 && r.mid <= 0.95;
  for (const ev of events) {
    const info = M.parseCryptoEvent(ev.title);
    const d = info && data[info.asset];
    if (!d || !(d.spot > 0)) continue;
    for (const rows of cryptoLadders(ev, info, d, now)) {
      rows.forEach((r, i) => {
        const left = rows.slice(0, i).filter(quoted).slice(-2), right = rows.slice(i + 1).filter(quoted).slice(0, 2);
        if (!left.length || !right.length) return;
        const fit = ladderSigma([...left, ...right]);
        if (!(fit.sigma > 0) || fit.worst > 0.03) return;
        const p = r.prob(fit.sigma);
        if (p == null || p < 0.03 || p > 0.97) return;
        const q = quoteEdge(r.m, p);
        if (q.edge >= 0.5 * minEdge && sidePrice(r.m, q.side) >= MIN_SIDE_PRICE) out.push({ key: `cx:${r.m.id}:${q.side}`, type: "crypto_levels", event: ev, market: r.m, side: q.side, prob: q.prob, hint: q.edge,
          model: `${info.asset} ${info.kind} S=${d.spot} (${d.source}) σ=${fit.sigma.toFixed(2)} by ${left.length + right.length} neighbours${d.sigma > 0 ? ` (${d.volSource || "vol"} ${d.sigma.toFixed(2)})` : ""} τ=${(r.tau / 3600000).toFixed(1)}h p=${p.toFixed(3)}` });
      });
    }
  }
  return out.sort((a, b) => b.hint - a.hint).slice(0, 12);
}

// --- AI pools ----------------------------------------------------------------------------------------------------
// Forecaster: liquid binary questions priced 8–92¢ that resolve in 2–60 days; not crypto, weather or sports, where
// the model agents or in-play information are faster than a language model.
function forecastPool(events, now, seen, { minDays = 2, maxDays = 60, limit = 6 } = {}) {
  const out = [];
  for (const ev of events) {
    if (["crypto", "weather", "sports"].includes(ev.sector) || SKIP_TITLE.test(ev.title)) continue;
    const markets = [...ev.markets].filter((m) => m.accepting && !m.closed).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, ev.negRisk ? 3 : 2);
    for (const m of markets) {
      if (m.liquidity < 10000 || !(m.bid > 0) || !(m.ask > 0) || m.ask - m.bid > 0.04) continue;
      const mid = (m.bid + m.ask) / 2;
      const end = endOf(ev, m);
      if (mid < 0.08 || mid > 0.92 || !end || end < now + minDays * 86400000 || end > now + maxDays * 86400000) continue;
      const prior = seen(m.id);
      if (prior && now - prior.at < 24 * 3600000 && Math.abs(prior.mid - mid) < 0.05) continue;
      out.push({ event: ev, market: m, mid, volume: ev.volume24h });
    }
  }
  return out.sort((a, b) => b.volume - a.volume).slice(0, limit);
}

// Near resolution: within 72 hours, one side priced 80–97¢. Has the deciding fact already happened?
function resolutionPool(events, now, seen, { limit = 6 } = {}) {
  const out = [];
  for (const ev of events) {
    if (["crypto", "weather"].includes(ev.sector) || SKIP_TITLE.test(ev.title) || isModelEvent(ev)) continue;
    for (const m of ev.markets) {
      if (!m.accepting || m.closed || m.liquidity < 1000 || !(m.bid > 0) || !(m.ask > 0)) continue;
      const end = endOf(ev, m);
      if (!end || end < now || end > now + 72 * 3600000) continue;
      const lean = m.ask >= 0.8 && m.ask <= 0.97 ? "yes" : m.bid >= 0.03 && m.bid <= 0.2 ? "no" : null;
      if (!lean) continue;
      const prior = seen(m.id);
      if (prior && now - prior.at < 6 * 3600000) continue;
      out.push({ event: ev, market: m, mid: (m.bid + m.ask) / 2, lean, liquidity: m.liquidity });
    }
  }
  return out.sort((a, b) => b.liquidity - a.liquidity).slice(0, limit);
}

// --- shadow maker ----------------------------------------------------------------------------------------------
function makerPool(events, now, limit = 4) {
  const out = [];
  for (const ev of events) {
    if (SKIP_TITLE.test(ev.title)) continue;
    for (const m of ev.markets) {
      if (!m.rewards || !m.accepting || m.closed || m.liquidity < 5000 || !(m.bid > 0) || !(m.ask > 0)) continue;
      const mid = (m.bid + m.ask) / 2;
      const end = endOf(ev, m);
      if (mid < 0.15 || mid > 0.85 || !end || end < now + 3 * 86400000) continue;
      if (m.ask - m.bid < 2 * m.tick - 1e-9 || (m.ask - m.bid) * 100 > m.rewards.maxSpread) continue;
      out.push({ event: ev, market: m, liquidity: m.liquidity });
    }
  }
  return out.sort((a, b) => b.liquidity - a.liquidity).slice(0, limit);
}

// A shadow quote rests at YES's best bid and at NO's best bid (1 − YES's best ask). It is filled only when the book
// trades through it: a YES ask below our YES bid, or a YES bid above 1 − our NO bid. No queue position is assumed,
// makers pay no fee and liquidity rewards are not counted.
function makerStep(prev, book, market, { size, maxShares, inventory, now }) {
  const fills = [];
  const bestBid = book.bids[0]?.[0] ?? null;
  const bestAsk = book.asks[0]?.[0] ?? null;
  const tick = book.tick || market.tick || 0.01;
  if (prev) {
    if (prev.yes != null && bestAsk != null && bestAsk <= prev.yes - tick / 2) fills.push({ side: "yes", price: prev.yes, shares: prev.size });
    if (prev.no != null && bestBid != null && bestBid >= 1 - prev.no + tick / 2) fills.push({ side: "no", price: prev.no, shares: prev.size });
  }
  const quote = {
    yes: bestBid != null && inventory.yes + size <= maxShares ? bestBid : null,
    no: bestAsk != null && inventory.no + size <= maxShares ? Math.round((1 - bestAsk) * 1e6) / 1e6 : null,
    size, at: now,
  };
  return { fills, quote };
}

module.exports = {
  SKIP_TITLE, MAX_LADDER_GAP, MIN_SIDE_PRICE, BOOK, WEATHER, weatherBlend, screenBundles, ladderKey, deadlineOf, screenLadders, sizeArbitrage, confirmArbitrage, confirmSingle, quoteEdge,
  screenFavorites, screenWeather, screenCrypto, ladderSigma, cryptoLadders, forecastPool, resolutionPool, makerPool, makerStep, isModelEvent,
};
