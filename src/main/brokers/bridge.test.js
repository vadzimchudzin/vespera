"use strict";

/** Polymarket Bridge: token/network grouping, address types, status decoding. */

const assert = require("assert");
const { BridgeClient, groupAssets, describeTransactions, formatUnits } = require("./bridge");

const ASSETS = [
  { chainId: "728126428", chainName: "Tron", token: { name: "Tether USD", symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 }, minCheckoutUsd: 2 },
  { chainId: "137", chainName: "Polygon", token: { name: "USD Coin (Wormhole)", symbol: "USDC", address: "0x4318CB63A2b8edf2De971E2F17F77097e499459D", decimals: 6 }, minCheckoutUsd: 2 },
  { chainId: "137", chainName: "Polygon", token: { name: "USDC", symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 }, minCheckoutUsd: 2 },
  { chainId: "1", chainName: "Ethereum", token: { name: "Tether USD", symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }, minCheckoutUsd: 3 },
  { chainId: "1151111081099710", chainName: "Solana", token: { name: "USDT", symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }, minCheckoutUsd: 2 },
  { chainId: "29780", chainName: "Lightning", token: { name: "Bitcoin", symbol: "BTC", address: "x", decimals: 8 }, minCheckoutUsd: 2 },
  { chainId: "1", chainName: "Ethereum", token: { name: "Dogecoin", symbol: "DOG", address: "0x1", decimals: 18 }, minCheckoutUsd: 3 },
];

// ── grouping ────────────────────────────────────────────────────────────────
{
  const tokens = groupAssets(ASSETS);
  assert.deepStrictEqual(tokens.map((x) => x.symbol), ["USDT", "USDC"], "curated tokens only; Lightning-only BTC dropped");
  const usdt = tokens[0];
  assert.deepStrictEqual(usdt.networks.map((n) => n.chainName), ["Tron", "Ethereum", "Solana"], "Tron first");
  assert.strictEqual(usdt.networks[0].addressType, "tron");
  assert.strictEqual(usdt.networks[0].icon, "trx");
  assert.strictEqual(usdt.networks[1].addressType, "evm");
  assert.strictEqual(usdt.networks[2].addressType, "svm");
  assert.strictEqual(usdt.networks[1].minUsd, 3);
  const usdc = tokens[1];
  assert.strictEqual(usdc.networks.length, 1, "one row per chain");
  assert.strictEqual(usdc.networks[0].tokenAddress, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "canonical USDC beats the Wormhole variant");
  assert.deepStrictEqual(groupAssets(null), []);
}

// ── amounts / status ────────────────────────────────────────────────────────
{
  assert.strictEqual(formatUnits("13566635", 6), "13.566635");
  assert.strictEqual(formatUnits("5000000", 6), "5");
  assert.strictEqual(formatUnits("1", 8), "0.00000001");
  assert.strictEqual(formatUnits("1234567890123456789", 18), "1.23456789");
  const rows = describeTransactions(
    [
      { fromChainId: "728126428", fromTokenAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", fromAmountBaseUnit: "25000000", status: "PROCESSING", createdTimeMs: 1 },
      { fromChainId: "1", fromTokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", fromAmountBaseUnit: "9100000", status: "COMPLETED", txHash: "0xabc" },
      { fromChainId: "999999", fromTokenAddress: "0xzz", fromAmountBaseUnit: "1", status: "FAILED" },
    ],
    ASSETS
  );
  assert.deepStrictEqual(
    rows.map((r) => [r.chainName, r.symbol, r.amount, r.state]),
    [
      ["Tron", "USDT", "25", "pending"],
      ["Ethereum", "USDT", "9.1", "done"],
      ["999999", "", null, "failed"],
    ],
    "token matched case-insensitively; unknown token keeps the raw chain"
  );
}

// ── client ──────────────────────────────────────────────────────────────────
(async () => {
  const calls = [];
  const request = async (url, opts = {}) => {
    calls.push([url, opts.method || "GET", opts.body]);
    if (url.endsWith("/supported-assets")) return { ok: true, status: 200, json: { supportedAssets: ASSETS } };
    if (url.endsWith("/deposit")) {
      return { ok: true, status: 201, json: { address: { evm: "0xE", svm: "S", tron: "TX", btc: "bc1" } } };
    }
    if (url.includes("/status/")) return { ok: true, status: 200, json: { transactions: [], nextCursor: null } };
    return { ok: false, status: 404, json: { error: "nope" } };
  };
  const client = new BridgeClient({ baseUrl: "https://bridge.test", request });

  const tokens = await client.assets();
  await client.assets();
  assert.strictEqual(tokens[0].symbol, "USDT");
  assert.strictEqual(calls.filter((c) => c[0].endsWith("/supported-assets")).length, 1, "assets cached");

  await assert.rejects(client.addresses("not-a-wallet"), /wallet_invalid/);
  const wallet = "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839";
  const addr = await client.addresses(wallet);
  assert.deepStrictEqual(addr, { evm: "0xE", svm: "S", tron: "TX", btc: "bc1" });
  await client.addresses(wallet.toLowerCase());
  const posts = calls.filter((c) => c[1] === "POST");
  assert.strictEqual(posts.length, 1, "bridge addresses cached per wallet");
  assert.deepStrictEqual(posts[0][2], { address: wallet.toLowerCase() });

  assert.deepStrictEqual(await client.status("TX"), []);
  assert.ok(calls.some((c) => c[0] === "https://bridge.test/status/TX?limit=10"));

  const down = new BridgeClient({ request: async () => ({ ok: false, status: 0, networkError: "timeout" }) });
  await assert.rejects(down.assets(), /timeout/);
  const blocked = new BridgeClient({ request: async () => ({ ok: false, status: 403, json: { error: "region blocked" } }) });
  await assert.rejects(blocked.addresses(wallet), /region blocked/);

  console.log("bridge tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
