"use strict";

// EIP-712 order signer for Polymarket CLOB V2 (live since 2026-04-28).
// V1-signed orders are rejected by production, see docs.polymarket.com/v2-migration.
// Chain: Polygon mainnet (chainId 137). Uses ethers@5 (CommonJS, works in Electron).

const CHAIN_ID = 137;
const EXCHANGE_ADDRESS = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_ADDRESS = "0xe2222d279d744050d28e00520010520000310F59";
const ZERO_BYTES32 = "0x" + "0".repeat(64);

const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
    { name: "timestamp",     type: "uint256" },
    { name: "metadata",      type: "bytes32" },
    { name: "builder",       type: "bytes32" },
  ],
};

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount," +
  "uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";

// ERC-7739 wrapper a Deposit Wallet validates against.
const TYPED_DATA_SIGN_TYPES = {
  ...ORDER_TYPES,
  TypedDataSign: [
    { name: "contents",          type: "Order"   },
    { name: "name",              type: "string"  },
    { name: "version",           type: "string"  },
    { name: "chainId",           type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt",              type: "bytes32" },
  ],
};

function exchangeDomain(negRisk = false) {
  return {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE_ADDRESS : EXCHANGE_ADDRESS,
  };
}

const DOMAIN = exchangeDomain(false);

/**
 * Build an unsigned V2 order struct.
 * `nonce`, `feeRateBps` and `taker` no longer exist: uniqueness comes from the
 * millisecond timestamp and fees are charged by the protocol at match time.
 */
function buildOrder({
  tokenId,
  makerAmount,
  takerAmount,
  maker,
  signer,
  side = 0,
  signatureType = 0,
  timestamp,
  metadata = ZERO_BYTES32,
  builder = ZERO_BYTES32,
}) {
  // the wire body sends salt as a JSON number, keep it inside MAX_SAFE_INTEGER
  const salt = String(Math.floor(Math.random() * 1e15));
  return {
    salt,
    // maker holds the funds; signer is the key (or, for a Deposit Wallet, the wallet itself)
    maker,
    signer: signer || maker,
    tokenId: String(tokenId),
    makerAmount: String(makerAmount),
    takerAmount: String(takerAmount),
    side: Number(side) === 1 ? 1 : 0,
    signatureType: Number(signatureType) || 0,
    timestamp: String(timestamp == null ? Date.now() : timestamp),
    metadata,
    builder,
  };
}

/**
 * Polymarket signature types.
 *  - DEPOSIT_WALLET: every account wallet deployed on or after 2026-05-04.
 *  - POLY_PROXY: legacy Magic / Google accounts.
 *  - POLY_GNOSIS_SAFE: legacy MetaMask / Rabby accounts.
 *  - EOA: the key itself holds the funds.
 */
const SIGNATURE_TYPES = { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2, DEPOSIT_WALLET: 3 };
const WALLET_TYPE_ALIASES = { GNOSIS_SAFE: "POLY_GNOSIS_SAFE", SAFE: "POLY_GNOSIS_SAFE", PROXY: "POLY_PROXY", POLY_1271: "DEPOSIT_WALLET" };

function normalizeWalletType(walletType) {
  const key = String(walletType || "").toUpperCase();
  const canonical = WALLET_TYPE_ALIASES[key] || key;
  return canonical in SIGNATURE_TYPES ? canonical : null;
}

function signatureTypeFor(walletType) {
  const key = normalizeWalletType(walletType);
  return key ? SIGNATURE_TYPES[key] : SIGNATURE_TYPES.EOA;
}

function orderMessage(order) {
  return {
    salt:          order.salt,
    maker:         order.maker,
    signer:        order.signer,
    tokenId:       order.tokenId,
    makerAmount:   order.makerAmount,
    takerAmount:   order.takerAmount,
    side:          order.side,
    signatureType: order.signatureType,
    timestamp:     order.timestamp,
    metadata:      order.metadata,
    builder:       order.builder,
  };
}

/**
 * Sign an order with EIP-712.
 * EOA / proxy / Safe orders carry the plain signature. A Deposit Wallet order
 * is signed as an ERC-7739 TypedDataSign and the signature is wrapped so the
 * wallet contract can validate it through ERC-1271.
 *
 * @returns {Promise<{ order: object, signature: string }>}
 */
async function signOrder(order, privateKey, { negRisk = false } = {}) {
  const ethers = loadEthers();
  const wallet = new ethers.Wallet(normalizeKey(privateKey));
  const domain = exchangeDomain(negRisk);
  const message = orderMessage(order);

  if (Number(order.signatureType) !== SIGNATURE_TYPES.DEPOSIT_WALLET) {
    const signature = await wallet._signTypedData(domain, ORDER_TYPES, message);
    return { order, signature };
  }

  const inner = await wallet._signTypedData(domain, TYPED_DATA_SIGN_TYPES, {
    contents: message,
    name: "DepositWallet",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: order.maker,
    salt: ZERO_BYTES32,
  });
  const { _TypedDataEncoder } = ethers.utils;
  const appDomainSeparator = _TypedDataEncoder.hashDomain(domain);
  const contentsHash = _TypedDataEncoder.hashStruct("Order", ORDER_TYPES, message);
  const typeBytes = ethers.utils.toUtf8Bytes(ORDER_TYPE_STRING);
  const signature = ethers.utils.hexConcat([
    inner,
    appDomainSeparator,
    contentsHash,
    typeBytes,
    ethers.utils.hexZeroPad(ethers.utils.hexlify(typeBytes.length), 2),
  ]);
  return { order, signature };
}

function orderHash(order, { negRisk = false } = {}) {
  return loadEthers().utils._TypedDataEncoder.hash(exchangeDomain(negRisk), ORDER_TYPES, orderMessage(order));
}

// ── legacy wallet address derivation (CREATE2) ────────────────────────────
// Lets AUTO tell a legacy proxy / Safe account from a Deposit Wallet without an RPC.

const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
const PROXY_INIT_CODE_HASH = "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b";
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
const SAFE_INIT_CODE_HASH = "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

function proxyWalletAddress(signer) {
  const { utils } = loadEthers();
  const salt = utils.keccak256(utils.solidityPack(["address"], [signer]));
  return utils.getCreate2Address(PROXY_FACTORY, salt, PROXY_INIT_CODE_HASH);
}

function safeWalletAddress(signer) {
  const { utils } = loadEthers();
  const salt = utils.keccak256(utils.defaultAbiCoder.encode(["address"], [signer]));
  return utils.getCreate2Address(SAFE_FACTORY, salt, SAFE_INIT_CODE_HASH);
}

/**
 * Wallet type implied by the two addresses. Anything that is not the key
 * itself nor its legacy proxy / Safe is treated as a Deposit Wallet, the
 * default for accounts created since May 2026.
 */
function detectWalletType(signer, walletAddress) {
  if (!signer || !walletAddress) return "EOA";
  const w = String(walletAddress).toLowerCase();
  if (String(signer).toLowerCase() === w) return "EOA";
  try {
    if (proxyWalletAddress(signer).toLowerCase() === w) return "POLY_PROXY";
    if (safeWalletAddress(signer).toLowerCase() === w) return "POLY_GNOSIS_SAFE";
  } catch {
    /* malformed address: fall through */
  }
  return "DEPOSIT_WALLET";
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
  NEG_RISK_EXCHANGE_ADDRESS,
  CHAIN_ID,
  DOMAIN,
  ORDER_TYPES,
  ORDER_TYPE_STRING,
  TYPED_DATA_SIGN_TYPES,
  ZERO_BYTES32,
  exchangeDomain,
  normalizeWalletType,
  proxyWalletAddress,
  safeWalletAddress,
  detectWalletType,
  CLOB_AUTH_DOMAIN,
  CLOB_AUTH_TYPES,
  CLOB_AUTH_MESSAGE,
  SIGNATURE_TYPES,
  signatureTypeFor,
  buildOrder,
  signOrder,
  orderHash,
  signClobAuth,
  addressFromPrivateKey,
};
