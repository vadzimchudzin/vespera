"use strict";

const { requestJson } = require("./clobClient");

/**
 * Polymarket Bridge API (bridge.polymarket.com): deposits from other chains
 * and tokens, converted to pUSD on Polygon in the Polymarket wallet.
 *
 * POST /deposit returns one bridge address per address type (evm, svm, tron,
 * btc). Sending to the wrong type loses funds, so only chains with a known
 * type are offered; Lightning (invoices) and Hypercore are left out.
 */

const BRIDGE_URL = "https://bridge.polymarket.com";

const CHAINS = {
  "1": { name: "Ethereum", type: "evm", icon: "eth" },
  "137": { name: "Polygon", type: "evm", icon: "matic" },
  "42161": { name: "Arbitrum", type: "evm", icon: "arb" },
  "8453": { name: "Base", type: "evm", icon: "base" },
  "10": { name: "Optimism", type: "evm", icon: "op" },
  "56": { name: "BNB Chain", type: "evm", icon: "bnb" },
  "999": { name: "HyperEVM", type: "evm", icon: "hype" },
  "143": { name: "Monad", type: "evm", icon: "monad" },
  "57073": { name: "Ink", type: "evm", icon: "ink" },
  "2741": { name: "Abstract", type: "evm", icon: "abstract" },
  "4663": { name: "Robinhood", type: "evm", icon: "" },
  "1151111081099710": { name: "Solana", type: "svm", icon: "sol" },
  "728126428": { name: "Tron", type: "tron", icon: "trx" },
  "8253038": { name: "Bitcoin", type: "btc", icon: "btc" },
};

// Order of the networks in the picker.
const CHAIN_ORDER = ["728126428", "137", "1", "56", "42161", "8453", "10", "1151111081099710", "8253038", "999", "143", "57073", "2741", "4663"];

// Tokens offered in the picker, most common first; the 200+ long tail is hidden.
const TOKENS = [
  { symbol: "USDT", icon: "usdt" },
  { symbol: "USDC", icon: "usdc" },
  { symbol: "ETH", icon: "eth" },
  { symbol: "SOL", icon: "sol" },
  { symbol: "BTC", icon: "btc" },
  { symbol: "BNB", icon: "bnb" },
  { symbol: "POL", icon: "matic" },
  { symbol: "DAI", icon: "dai" },
  { symbol: "USDe", icon: "usde" },
  { symbol: "USDT0", icon: "usdt" },
  { symbol: "USDC.e", icon: "usdc" },
];

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
}

/** Bridged variants ("USD Coin (Wormhole)", "(PoS)") rank after the canonical token. */
function variantRank(name) {
  return /\(|wormhole|bridged/i.test(String(name || "")) ? 1 : 0;
}

/**
 * Supported-assets list → picker model:
 * [{ symbol, icon, networks: [{ chainId, chainName, icon, addressType, minUsd, tokenAddress, tokenName, decimals }] }]
 */
function groupAssets(list) {
  const bySymbol = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    const chainId = String((row && row.chainId) || "");
    const chain = CHAINS[chainId];
    const token = (row && row.token) || {};
    if (!chain || !TOKENS.some((x) => x.symbol === token.symbol)) continue;
    const entry = {
      chainId,
      chainName: chain.name,
      icon: chain.icon,
      addressType: chain.type,
      minUsd: Number(row.minCheckoutUsd) || 0,
      tokenAddress: String(token.address || ""),
      tokenName: String(token.name || token.symbol),
      decimals: Number(token.decimals) || 0,
    };
    if (!bySymbol.has(token.symbol)) bySymbol.set(token.symbol, new Map());
    const nets = bySymbol.get(token.symbol);
    const prev = nets.get(chainId);
    if (!prev || variantRank(entry.tokenName) < variantRank(prev.tokenName)) nets.set(chainId, entry);
  }
  return TOKENS.filter((x) => bySymbol.has(x.symbol)).map((x) => ({
    symbol: x.symbol,
    icon: x.icon,
    networks: [...bySymbol.get(x.symbol).values()].sort(
      (a, b) => CHAIN_ORDER.indexOf(a.chainId) - CHAIN_ORDER.indexOf(b.chainId)
    ),
  }));
}

function formatUnits(baseUnits, decimals) {
  const raw = String(baseUnits || "0").replace(/\D/g, "") || "0";
  const d = Math.max(0, Number(decimals) || 0);
  const padded = raw.padStart(d + 1, "0");
  const whole = padded.slice(0, padded.length - d);
  const frac = d ? padded.slice(-d).slice(0, 8).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** Status rows → display rows. `assets` is the raw supported-assets list (symbol + decimals). */
function describeTransactions(transactions, assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (Array.isArray(transactions) ? transactions : []).map((tx) => {
    const chainId = String(tx.fromChainId || "");
    const addr = String(tx.fromTokenAddress || "").toLowerCase();
    const asset = list.find(
      (a) => String(a.chainId) === chainId && String((a.token || {}).address || "").toLowerCase() === addr
    );
    const token = (asset && asset.token) || null;
    const status = String(tx.status || "");
    return {
      chainName: (CHAINS[chainId] && CHAINS[chainId].name) || (asset && asset.chainName) || chainId,
      symbol: token ? token.symbol : "",
      amount: token ? formatUnits(tx.fromAmountBaseUnit, token.decimals) : null,
      status,
      state: status === "COMPLETED" ? "done" : status === "FAILED" ? "failed" : "pending",
      txHash: tx.txHash || null,
      createdTimeMs: tx.createdTimeMs || null,
    };
  });
}

function errorOf(res) {
  if (res.networkError) return res.networkError;
  if (res.json && res.json.error) return String(res.json.error);
  return `http_${res.status}`;
}

class BridgeClient {
  constructor({ baseUrl = BRIDGE_URL, request = requestJson } = {}) {
    this.baseUrl = baseUrl;
    this.request = request;
    this._assets = null;
    this._assetsAt = 0;
    this._addresses = new Map();
  }

  async rawAssets({ maxAgeMs = 10 * 60_000 } = {}) {
    if (this._assets && Date.now() - this._assetsAt < maxAgeMs) return this._assets;
    const res = await this.request(`${this.baseUrl}/supported-assets`);
    if (!res.ok || !res.json || !Array.isArray(res.json.supportedAssets)) {
      if (this._assets) return this._assets; // stale beats nothing
      throw new Error(errorOf(res));
    }
    this._assets = res.json.supportedAssets;
    this._assetsAt = Date.now();
    return this._assets;
  }

  async assets() {
    return groupAssets(await this.rawAssets());
  }

  /** Bridge addresses for a Polymarket wallet; stable per wallet, so cached. */
  async addresses(wallet) {
    const key = String(wallet || "").trim().toLowerCase();
    if (!isEvmAddress(key)) throw new Error("wallet_invalid");
    if (this._addresses.has(key)) return this._addresses.get(key);
    const res = await this.request(`${this.baseUrl}/deposit`, { method: "POST", body: { address: key } });
    const addr = res.json && res.json.address;
    if (!res.ok || !addr || !addr.evm) throw new Error(errorOf(res));
    const out = { evm: addr.evm || "", svm: addr.svm || "", tron: addr.tron || "", btc: addr.btc || "" };
    this._addresses.set(key, out);
    return out;
  }

  async status(bridgeAddress, { limit = 10 } = {}) {
    const addr = String(bridgeAddress || "").trim();
    if (!addr) throw new Error("address_missing");
    const res = await this.request(`${this.baseUrl}/status/${encodeURIComponent(addr)}?limit=${limit}`);
    if (!res.ok || !res.json) throw new Error(errorOf(res));
    const assets = await this.rawAssets().catch(() => []);
    return describeTransactions(res.json.transactions, assets);
  }
}

module.exports = {
  BridgeClient,
  groupAssets,
  describeTransactions,
  formatUnits,
  isEvmAddress,
  CHAINS,
  TOKENS,
  BRIDGE_URL,
};
