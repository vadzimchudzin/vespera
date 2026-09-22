"use strict";

// EIP-712 order signer for Polymarket CLOB
// Chain: Polygon mainnet (chainId 137)
// Uses ethers@5 (CommonJS compatible — works in Electron)
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
 * Sign an order with EIP-712 via ethers@5 (CommonJS, works in Electron).
 *
 * @param {object} order       - unsigned order from buildOrder()
 * @param {string} privateKey  - 0x-prefixed hex private key
 * @returns {Promise<{ order: object, signature: string }>}
 */
async function signOrder(order, privateKey) {
  let ethers;
  try {
    ({ ethers } = require("ethers"));
  } catch {
    throw new Error("ethers not found — run: npm install");
  }

  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(pk);

  const message = {
    salt:          order.salt,
    maker:         order.maker,
    signer:        order.signer,
    taker:         order.taker,
    tokenId:       order.tokenId,
    makerAmount:   order.makerAmount,
    takerAmount:   order.takerAmount,
    expiration:    order.expiration,
    nonce:         order.nonce,
    feeRateBps:    order.feeRateBps,
    side:          order.side,
    signatureType: order.signatureType,
  };

  // ethers v5: _signTypedData(domain, types, value)
  const signature = await wallet._signTypedData(DOMAIN, ORDER_TYPES, message);

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
