// Shared crypto helpers for the exam vault.
// Runs unchanged in Node (>= 20) and in the browser (Vite): only WebCrypto
// (globalThis.crypto), Uint8Array, ethers v6, shamir-secret-sharing and multiformats.
//
// Encrypted paper envelope ("EXV1"):
//   "EXV1" (4 bytes) | IV (12 bytes) | AES-256-GCM( [uint16 BE nameLen][utf8 name][file bytes] ) + 16-byte tag
import { AbiCoder, getAddress, keccak256 } from "ethers";
import { split, combine } from "shamir-secret-sharing";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export const PAPER_LABELS = ["A", "B", "C"];

const MAGIC = new Uint8Array([0x45, 0x58, 0x56, 0x31]); // "EXV1"
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
  return s;
};

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function asBytes(x, what = "value") {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === "string") return fromHex(x);
  throw new TypeError(`${what} must be a Uint8Array or 0x-hex string`);
}

function checkKey(key) {
  const k = asBytes(key, "key");
  if (k.length !== KEY_LEN) throw new Error(`AES key must be ${KEY_LEN} bytes, got ${k.length}`);
  return k;
}

// ------------------------------------------------------------------ hex helpers

export function toHex(bytes) {
  const b = asBytes(bytes, "bytes");
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex) {
  if (typeof hex !== "string") throw new TypeError("hex must be a string");
  let h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex string: ${hex.slice(0, 20)}...`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ------------------------------------------------------------------ keys & AES

/** 32 random bytes for AES-256-GCM. */
export async function generateKey() {
  return randomBytes(KEY_LEN);
}

const importKey = (key, usage) => subtle().importKey("raw", checkKey(key), { name: "AES-GCM" }, false, [usage]);

/** Encrypts a paper (with its file name) into an EXV1 envelope. */
export async function encryptPaper(plainBytes, fileName, key) {
  const data = asBytes(plainBytes, "plainBytes");
  const name = new TextEncoder().encode(String(fileName ?? ""));
  if (name.length > 0xffff) throw new Error("file name too long");

  const inner = new Uint8Array(2 + name.length + data.length);
  inner[0] = name.length >> 8;
  inner[1] = name.length & 0xff;
  inner.set(name, 2);
  inner.set(data, 2 + name.length);

  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, await importKey(key, "encrypt"), inner));

  const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_LEN);
  return out;
}

/** Decrypts an EXV1 envelope. Throws on bad format, wrong key or tampering. */
export async function decryptPaper(encBytes, key) {
  const enc = asBytes(encBytes, "encBytes");
  if (enc.length < MAGIC.length + IV_LEN + TAG_LEN + 2) throw new Error("Not an encrypted exam paper: file too short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (enc[i] !== MAGIC[i]) throw new Error('Not an encrypted exam paper: missing "EXV1" header');
  }
  const iv = enc.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const ct = enc.subarray(MAGIC.length + IV_LEN);
  const k = await importKey(key, "decrypt");

  let inner;
  try {
    inner = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, k, ct));
  } catch {
    throw new Error("Decryption failed: wrong key or the file was modified");
  }
  if (inner.length < 2) throw new Error("Decrypted payload is malformed");
  const nameLen = (inner[0] << 8) | inner[1];
  if (2 + nameLen > inner.length) throw new Error("Decrypted payload is malformed");
  const fileName = new TextDecoder().decode(inner.subarray(2, 2 + nameLen));
  return { fileName, bytes: inner.slice(2 + nameLen) };
}

// ------------------------------------------------------------------ Shamir

/** Splits a key into `shares` Shamir shares, any `threshold` of which rebuild it. */
export async function splitKey(key, shares = 5, threshold = 3) {
  return split(checkKey(key), shares, threshold);
}

/** Rebuilds a key from Shamir shares (Uint8Array or 0x-hex). */
export async function combineKey(shares) {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error("Need at least 2 shares to combine");
  return combine(shares.map((s) => asBytes(s, "share")));
}

// ------------------------------------------------------------------ hashes & commitments

const abi = AbiCoder.defaultAbiCoder();

/** keccak256 of the encrypted file, as stored on-chain. */
export function paperHash(encBytes) {
  return keccak256(asBytes(encBytes, "encBytes"));
}

/** = ExamVault.seedCommitment: keccak256(abi.encode(address vault, address staff, uint256 seed)). */
export function seedCommitment(vault, staff, seed) {
  return keccak256(abi.encode(["address", "address", "uint256"], [getAddress(vault), getAddress(staff), BigInt(seed)]));
}

/** = ExamVault.pieceCommitment: keccak256(abi.encode(address, address, uint8 paper, bytes piece)). */
export function pieceCommitment(vault, staff, paper, piece) {
  const p = Number(paper);
  if (!Number.isInteger(p) || p < 0 || p > 255) throw new Error(`invalid paper index: ${paper}`);
  return keccak256(
    abi.encode(["address", "address", "uint8", "bytes"], [getAddress(vault), getAddress(staff), p, asBytes(piece, "piece")]),
  );
}

/** Random uint256 from 32 random bytes. */
export function randomSeed() {
  return BigInt(toHex(randomBytes(32)));
}

// ------------------------------------------------------------------ IPFS

/** CIDv1 (raw codec, sha2-256), base32 — what `ipfs add --cid-version=1 --raw-leaves` gives for a small file. */
export async function cidForBytes(bytes) {
  const digest = await sha256.digest(asBytes(bytes, "bytes"));
  return CID.create(1, raw.code, digest).toString();
}
