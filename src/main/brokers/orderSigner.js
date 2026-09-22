"use strict";

// EIP-712 order signer for Polymarket CLOB
// Chain: Polygon mainnet (chainId 137)
// Exchange contract: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E

const EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const CHAIN_ID = 137;

const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
};

const DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_ADDRESS,
};

/**
 * Build an unsigned CTF order struct.
 * @param {object} p
 * @param {string} p.tokenId     - YES/NO token ID (uint256 as decimal string)
 * @param {string} p.makerAmount - USDC collateral amount (6 decimals, as string)
 * @param {string} p.takerAmount - outcome token amount (as string)
 * @param {string} p.maker       - wallet address (checksummed)
 * @param {0|1}   [p.side=0]    - 0 = BUY, 1 = SELL
 * @param {number} [p.expiration=0]   - unix seconds, 0 = no expiry
 * @param {number} [p.feeRateBps=0]
 * @returns {object} unsigned order
 */
function buildOrder({
  tokenId,
  makerAmount,
  takerAmount,
  maker,
  side = 0,
  expiration = 0,
  feeRateBps = 0,
}) {
  const salt = BigInt(Math.floor(Math.random() * 1e15)).toString();
  return {
    salt,
    maker,
    signer: maker,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: String(tokenId),
    makerAmount: String(makerAmount),
    takerAmount: String(takerAmount),
    expiration: String(expiration),
    nonce: "0",
    feeRateBps: String(feeRateBps),
    side,
    signatureType: 0, // EOA
  };
}

/**
 * Sign an order with EIP-712 via viem.
 * viem must be in node_modules (added as dependency in package.json).
 *
 * @param {object} order       - unsigned order from buildOrder()
 * @param {string} privateKey  - 0x-prefixed hex private key
 * @returns {Promise<{ order: object, signature: string }>}
 */
async function signOrder(order, privateKey) {
  let privateKeyToAccount, createWalletClient, http, polygon;
  try {
    ({ privateKeyToAccount } = require("viem/accounts"));
    ({ createWalletClient, http } = require("viem"));
    ({ polygon } = require("viem/chains"));
  } catch {
    throw new Error("viem not found — run: npm install viem");
  }

  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  const client = createWalletClient({ account, chain: polygon, transport: http() });

  const signature = await client.signTypedData({
    account,
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt:          BigInt(order.salt),
      maker:         order.maker,
      signer:        order.signer,
      taker:         order.taker,
      tokenId:       BigInt(order.tokenId),
      makerAmount:   BigInt(order.makerAmount),
      takerAmount:   BigInt(order.takerAmount),
      expiration:    BigInt(order.expiration),
      nonce:         BigInt(order.nonce),
      feeRateBps:    BigInt(order.feeRateBps),
      side:          order.side,
      signatureType: order.signatureType,
    },
  });

  return { order, signature };
}

module.exports = {
  EXCHANGE_ADDRESS,
  CHAIN_ID,
  DOMAIN,
  ORDER_TYPES,
  buildOrder,
  signOrder,
};
