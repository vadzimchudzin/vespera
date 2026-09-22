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
  signer,
  side = 0,
  expiration = 0,
  feeRateBps = 0,
  signatureType = 0,
}) {
  const salt = BigInt(Math.floor(Math.random() * 1e15)).toString();
  return {
    salt,
    // maker is the account that holds the funds (the proxy / deposit wallet
    // for email accounts); signer is the key that actually signs.
    maker,
    signer: signer || maker,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: String(tokenId),
    makerAmount: String(makerAmount),
    takerAmount: String(takerAmount),
    expiration: String(expiration),
    nonce: "0",
    feeRateBps: String(feeRateBps),
    side,
    signatureType: Number(signatureType) || 0,
  };
}

/**
 * Polymarket signature types.
 * Email / Google accounts hold funds in a proxy wallet, so the order must be
 * signed by the exported key but funded by the wallet address — that is type 1,
 * not 0. Signing a proxy account as EOA gets the order rejected.
 */
const SIGNATURE_TYPES = { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2, DEPOSIT_WALLET: 3 };

function signatureTypeFor(walletType) {
  const key = String(walletType || "").toUpperCase();
  if (key in SIGNATURE_TYPES) return SIGNATURE_TYPES[key];
  return SIGNATURE_TYPES.EOA;
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

/**
 * L1 auth: prove control of the signer address so the CLOB will hand out
 * (or hand back) the L2 credentials — apiKey / secret / passphrase.
 * These are NOT created in the Polymarket web UI; they are derived from a
 * signature, which is why the app does it instead of asking the user.
 */
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: CHAIN_ID,
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ],
};

const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

function loadEthers() {
  try {
    // eslint-disable-next-line global-require
    const { ethers } = require("ethers");
    return ethers;
  } catch {
    throw new Error("ethers not found — run: npm install");
  }
}

function normalizeKey(privateKey) {
  const pk = String(privateKey || "").trim();
  if (!pk) throw new Error("missing_private_key");
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

/** Address of the EOA behind a signing key. */
function addressFromPrivateKey(privateKey) {
  const ethers = loadEthers();
  return new ethers.Wallet(normalizeKey(privateKey)).address;
}

/**
 * Sign the ClobAuth payload.
 * @returns {Promise<{ address, signature, timestamp, nonce }>}
 */
async function signClobAuth(privateKey, { timestamp, nonce = 0 } = {}) {
  const ethers = loadEthers();
  const wallet = new ethers.Wallet(normalizeKey(privateKey));
  const ts = String(timestamp || Math.floor(Date.now() / 1000));
  const message = {
    address: wallet.address,
    timestamp: ts,
    nonce: Number(nonce) || 0,
    message: CLOB_AUTH_MESSAGE,
  };
  const signature = await wallet._signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, message);
  return { address: wallet.address, signature, timestamp: ts, nonce: Number(nonce) || 0 };
}

module.exports = {
  EXCHANGE_ADDRESS,
  CHAIN_ID,
  DOMAIN,
  ORDER_TYPES,
  CLOB_AUTH_DOMAIN,
  CLOB_AUTH_TYPES,
  CLOB_AUTH_MESSAGE,
  SIGNATURE_TYPES,
  signatureTypeFor,
  buildOrder,
  signOrder,
  signClobAuth,
  addressFromPrivateKey,
};
