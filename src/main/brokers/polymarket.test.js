"use strict";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const { updownSlug, floorStartUnix, mapTokens, normalizeRound, resolveUpDown, assetFromSymbol } = require("./polymarketMarkets");
const { PolymarketAdapter } = require("./polymarketAdapter");
const { createVenue } = require("./index");

{
  assert(assetFromSymbol("BTCUSDT") === "btc", "btc asset");
  assert(assetFromSymbol("ETHUSDT") === "eth", "eth asset");
  const start = floorStartUnix(1_789_677_226_000, "15m");
  assert(start === 1_789_677_000, `floor 15m got ${start}`);
  assert(updownSlug("BTCUSDT", "15m", 1_789_677_226_000) === "btc-updown-15m-1789677000", "btc 15m slug");
  assert(updownSlug("ETHUSDT", "5m", 1_789_677_226_000).startsWith("eth-updown-5m-"), "eth 5m slug");
}

{
  const tokens = mapTokens({
    outcomes: '["Up","Down"]',
    clobTokenIds: '["111","222"]',
  });
  assert(tokens.UP === "111" && tokens.DOWN === "222", "map Up/Down tokens");
}

{
  const event = {
    title: "Bitcoin Up or Down",
    active: true,
    closed: false,
    markets: [
      {
        question: "Bitcoin Up or Down",
        outcomes: ["Up", "Down"],
        clobTokenIds: ["aaa", "bbb"],
        active: true,
        closed: false,
        acceptingOrders: true,
        conditionId: "0xabc",
      },
    ],
  };
  const round = normalizeRound(event, "btc-updown-15m-1");
  assert(round.acceptingOrders === true, "accepting");
  assert(round.tokens.UP === "aaa" && round.tokens.DOWN === "bbb", "tokens");
}

async function adapterCases() {
  {
    const client = {
      async eventBySlug() {
        return {
          ok: true,
          status: 200,
          latencyMs: 12,
          json: {
            title: "Bitcoin Up or Down",
            active: true,
            closed: false,
            markets: [
              {
                question: "Bitcoin Up or Down",
                outcomes: ["Up", "Down"],
                clobTokenIds: ["up-id", "down-id"],
                active: true,
                closed: false,
                acceptingOrders: true,
              },
            ],
          },
        };
      },
    };
    const res = await resolveUpDown(client, { symbol: "BTCUSDT", timeframe: "15m", tsMs: 1_789_677_226_000 });
    assert(res.ok === true, "resolve ok");
    assert(res.slug === "btc-updown-15m-1789677000", res.slug);
    assert(res.round.tokens.UP === "up-id", "up token");
  }

  const client = {
    async time() {
      return { ok: true, status: 200, latencyMs: 9, json: 1789677227 };
    },
    async eventBySlug(slug) {
      return {
        ok: true,
        status: 200,
        latencyMs: 11,
        json: {
          title: "Bitcoin Up or Down - test",
          active: true,
          closed: false,
          markets: [
            {
              question: "Bitcoin Up or Down - test",
              outcomes: ["Up", "Down"],
              clobTokenIds: ["u", "d"],
              active: true,
              closed: false,
              acceptingOrders: true,
            },
          ],
        },
      };
    },
  };
  const live = new PolymarketAdapter({ client, symbol: "BTCUSDT", timeframe: "15m" });
  const ping = await live.ping();
  assert(ping.ok === true, `ping ${ping.message}`);
  assert(ping.venue === "polymarket", ping.venue);
  assert(ping.trading === false, "no live trading yet");
  const round = await live.resolveRound(1_789_677_226_000);
  assert(round.ok && round.round.tokens.UP === "u", "resolve Up token");
  const bal = await live.getBalance();
  assert(bal == null, "no L2 balance");
  let threw = false;
  try {
    await live.marketBuy({ side: "UP", sizeUsd: "1.00" });
  } catch (err) {
    threw = err.code === "auto_not_wired";
  }
  assert(threw, "marketBuy still blocked");

  const viaFactory = createVenue("auto", { client });
  const p2 = await viaFactory.ping();
  assert(p2.venue === "polymarket", "factory auto is polymarket");

  const l2client = {
    async time() {
      return { ok: true, status: 200, latencyMs: 4, json: 1 };
    },
    async eventBySlug() {
      return client.eventBySlug();
    },
    async balanceAllowance() {
      return { ok: true, status: 200, json: { balance: "12500000" } };
    },
  };
  const wired = new PolymarketAdapter({
    client: l2client,
    apiKey: "k",
    apiSecret: "s",
    apiPassphrase: "p",
    walletAddress: "0xabc",
    symbol: "BTCUSDT",
    timeframe: "15m",
  });
  assert(wired.hasL2() === true, "L2 complete");
  const pingL2 = await wired.ping();
  assert(pingL2.l2 && pingL2.l2.ok === true, "L2 ping");
  const usd = await wired.getBalance();
  assert(usd === "12.50", `pUSD from wei got ${usd}`);
}

adapterCases()
  .then(() => {
    console.log("polymarket tests ok");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
