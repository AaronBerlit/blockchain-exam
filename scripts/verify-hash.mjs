#!/usr/bin/env node
// Checks an encrypted paper against the keccak256 fingerprint stored on-chain.
//   node scripts/verify-hash.mjs <encryptedFile> <expected 0xhash>
//   node scripts/verify-hash.mjs --cid <cid> <expected 0xhash>   (reads frontend/public/ipfs/<cid>)
// Prints PASS / FAIL and exits 0 / 1 (2 on usage errors).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paperHash } from "../shared/vaultCrypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = () => {
  console.error("usage: node scripts/verify-hash.mjs <encryptedFile> <expected 0xhash>\n       node scripts/verify-hash.mjs --cid <cid> <expected 0xhash>");
  process.exit(2);
};

const args = process.argv.slice(2);
let file, expected;
if (args[0] === "--cid") {
  if (args.length !== 3 || !/^[a-zA-Z0-9]+$/.test(args[1])) usage();
  file = path.join(ROOT, "frontend", "public", "ipfs", args[1]);
  expected = args[2];
} else {
  if (args.length !== 2) usage();
  [file, expected] = args;
}
if (!/^0x[0-9a-fA-F]{64}$/.test(expected)) {
  console.error(`Expected hash must be 0x followed by 64 hex characters, got: ${expected}`);
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}

const actual = paperHash(new Uint8Array(fs.readFileSync(file)));
const ok = actual.toLowerCase() === expected.toLowerCase();
console.log(`${ok ? "PASS" : "FAIL"}  ${file}`);
console.log(`  expected ${expected.toLowerCase()}`);
console.log(`  actual   ${actual}`);
process.exit(ok ? 0 : 1);
