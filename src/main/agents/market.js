"use strict";

// Polymarket public data for the agents desk: Gamma (events, markets, resolutions) and the CLOB (order books).
// Everything is reduced to the few fields the scanners and the paper book use.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const BOOK_BATCH = 200;   // POST /books takes ~500 tokens; 1000 is refused as too large
const ID_BATCH = 20;
const PAGE_BYTES = 24 * 1024 * 1024;

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ms = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
};
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : "");
function list(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Sector of an event from its tags (first match wins): limits exposure to one theme.
const SECTOR_TAGS = [
  ["crypto", ["crypto", "bitcoin", "ethereum", "solana", "xrp", "crypto-prices", "memecoins", "stablecoins", "airdrops", "dogecoin"]],
  ["weather", ["weather", "daily-temperature", "climate", "hurricanes", "earthquakes", "natural-disasters", "temperature", "climate-science"]],
  ["sports", ["sports", "nba", "nfl", "mlb", "nhl", "soccer", "tennis", "golf", "ufc", "mma", "boxing", "f1", "cricket", "esports", "epl",
    "ncaa", "ncaab", "cfb", "basketball", "football", "baseball", "hockey", "champions-league", "la-liga", "serie-a", "bundesliga", "games"]],
  ["finance", ["finance", "economy", "business", "fed", "fed-rates", "inflation", "stocks", "earnings", "economic-policy", "ipos", "commodities",
    "tariffs", "gdp", "equities"]],
  ["politics", ["politics", "elections", "us-politics", "world-elections", "global-elections", "trump", "congress", "senate", "geopolitics",
    "world", "ukraine", "russia", "israel", "middle-east", "china", "iran", "foreign-policy", "midterms", "us-election"]],
  ["culture", ["culture", "pop-culture", "entertainment", "movies", "music", "awards", "oscars", "tv", "celebrities", "mentions", "youtube"]],
  ["tech", ["tech", "ai", "openai", "big-tech", "science", "space", "spacex"]],
];
function sectorOf(tags) {
  const set = new Set(tags);
  for (const [name, slugs] of SECTOR_TAGS) if (slugs.some((slug) => set.has(slug))) return name;
  return "other";
}

function compactMarket(m) {
  const tokens = list(m.clobTokenIds).map(String);
  const outcomes = list(m.outcomes).map(String);
  const prices = list(m.outcomePrices).map(num);
  const schedule = m.feeSchedule && typeof m.feeSchedule === "object" ? m.feeSchedule : {};
  // Fees on: the market's schedule; a market that charges without publishing a rate is priced at 5% (conservative).
  const rate = m.feesEnabled === true ? (num(schedule.rate) ?? 0.05) : 0;
  return {
    id: String(m.id || ""), conditionId: str(m.conditionId, 80), slug: str(m.slug, 200),
    question: str(m.question, 300), label: str(m.groupItemTitle, 120) || str(m.question, 120),
    yes: tokens[0] || null, no: tokens[1] || null, outcomes: [outcomes[0] || "Yes", outcomes[1] || "No"],
    price: prices[0] ?? null, bid: num(m.bestBid), ask: num(m.bestAsk), last: num(m.lastTradePrice),
    liquidity: num(m.liquidity) || 0, volume: num(m.volume) || 0, tick: num(m.orderPriceMinTickSize) || 0.01,
    fee: { rate, exponent: num(schedule.exponent) || 1 },
    rewards: num(m.rewardsMinSize) > 0 && num(m.rewardsMaxSpread) > 0 ? { minSize: num(m.rewardsMinSize), maxSpread: num(m.rewardsMaxSpread) } : null,
    accepting: m.acceptingOrders === true, closed: m.closed === true, endDate: ms(m.endDate),
  };
}

// One game is often listed as several events ("… - More Markets" names its parent, and both carry the game's id):
// they share the per-event limit. Without a game or a parent an event is its own match.
function matchKey(e) {
  const game = Number(e?.gameId);
  if (Number.isSafeInteger(game) && game > 0) return `game:${game}`;
  const parent = e?.parentEventId == null ? "" : String(e.parentEventId);
  if (/^\d{1,15}$/.test(parent)) return `ev:${parent}`;
  return `ev:${String(e?.id || "")}`;
}

function compactEvent(e) {
  const tags = Array.isArray(e.tags) ? e.tags.map((t) => String(t?.slug || "")).filter(Boolean).slice(0, 24) : [];
  const markets = (Array.isArray(e.markets) ? e.markets : []).map(compactMarket).filter((m) => m.id && m.yes && m.no);
  return {
    id: String(e.id || ""), match: matchKey(e), slug: str(e.slug, 200), title: str(e.title, 200), description: str(e.description, 1500),
    endDate: ms(e.endDate), startDate: ms(e.startDate),
    negRisk: e.negRisk === true, augmented: e.negRiskAugmented === true,
    volume24h: num(e.volume24hr) || 0, liquidity: num(e.liquidity) || 0,
    tags, sector: sectorOf(tags), markets,
  };
}

async function fetchTopEvents(net, { pages = 3 } = {}) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const page = await net.json(`${GAMMA}/events/keyset?closed=false&order=volume24hr&ascending=false&limit=100&market_projection=card${cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : ""}`, { maxBytes: PAGE_BYTES });
    const rows = Array.isArray(page?.events) ? page.events : [];
    out.push(...rows.map(compactEvent));
    cursor = typeof page?.next_cursor === "string" ? page.next_cursor : "";
    if (!cursor || rows.length < 100) break;
  }
  return out;
}

// Offset pages of /events (at most 100 rows each) for one filter, e.g. a tag or an end-date window.
async function fetchEvents(net, query, { pages = 1 } = {}) {
  const out = [];
  for (let i = 0; i < pages; i++) {
    const rows = await net.json(`${GAMMA}/events?${query}&limit=100&offset=${i * 100}&market_projection=card`, { maxBytes: PAGE_BYTES });
    if (!Array.isArray(rows)) break;
    out.push(...rows.map(compactEvent));
    if (rows.length < 100) break;
  }
  return out;
}

async function fetchEventsById(net, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const query = ids.slice(i, i + ID_BATCH).map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const rows = await net.json(`${GAMMA}/events?${query}&market_projection=card`, { maxBytes: PAGE_BYTES });
    if (Array.isArray(rows)) out.push(...rows.map(compactEvent));
  }
  return out;
}

// Book levels best first: bids high → low, asks low → high (the REST book lists both the other way round).
function normalizeBook(row) {
  if (!row || typeof row.asset_id !== "string") return null;
  const side = (levels, descending) => (Array.isArray(levels) ? levels : [])
    .map((level) => [num(level?.price), num(level?.size)])
    .filter(([p, s]) => p > 0 && p < 1 && s > 0)
    .sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, 60);
  return {
    token: row.asset_id, bids: side(row.bids, true), asks: side(row.asks, false),
    minSize: num(row.min_order_size) || 5, tick: num(row.tick_size) || 0.01,
    at: num(row.timestamp) || null,
  };
}

async function fetchBooks(net, tokens, now = Date.now()) {
  const books = new Map();
  const unique = [...new Set(tokens.filter(Boolean))];
  for (let i = 0; i < unique.length; i += BOOK_BATCH) {
    const rows = await net.json(`${CLOB}/books`, { method: "POST", body: unique.slice(i, i + BOOK_BATCH).map((id) => ({ token_id: id })), maxBytes: 16 * 1024 * 1024 });
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const book = normalizeBook(row);
      if (book) books.set(book.token, { ...book, fetchedAt: now });
    }
  }
  return books;
}

// The NO side of a binary market is the mirror of the YES book: NO asks are 1 − YES bids, NO bids 1 − YES asks.
function mirror(book) {
  if (!book) return null;
  const flip = (levels) => levels.map(([p, s]) => [Math.round((1 - p) * 1e6) / 1e6, s]);
  return { ...book, bids: flip(book.asks), asks: flip(book.bids) };
}

// Closed markets with a final price per outcome. Gamma returns closed markets only when asked with closed=true;
// a condition id missing from the answer is still open.
async function fetchResolutions(net, conditionIds) {
  const out = new Map();
  const unique = [...new Set(conditionIds.filter((id) => /^0x[a-f0-9]{64}$/i.test(id || "")))];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const query = unique.slice(i, i + ID_BATCH).map((id) => `condition_ids=${id}`).join("&");
    const rows = await net.json(`${GAMMA}/markets?${query}&closed=true&limit=100`, { maxBytes: 4 * 1024 * 1024 });
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const prices = list(row.outcomePrices).map(num);
      const final = row.closed === true && prices.length === 2 && prices.every((p) => p != null && [0, 0.5, 1].some((x) => Math.abs(p - x) < 1e-6)) &&
        Math.abs(prices[0] + prices[1] - 1) < 1e-6;
      if (final) out.set(String(row.conditionId), { prices: prices.map((p) => Math.round(p * 2) / 2), status: str(row.umaResolutionStatus, 40) || null });
    }
  }
  return out;
}

module.exports = { matchKey,
  GAMMA, CLOB, BOOK_BATCH, num, list, sectorOf, compactMarket, compactEvent,
  fetchTopEvents, fetchEvents, fetchEventsById, fetchBooks, normalizeBook, mirror, fetchResolutions,
};
