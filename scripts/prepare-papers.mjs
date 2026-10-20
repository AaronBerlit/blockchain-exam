#!/usr/bin/env node
// Paper setter's tool: encrypts papers A/B/C, uploads the ciphertexts to IPFS and
// splits each AES key into 5 Shamir shares (any 3 rebuild it), one file per staff member.
//
//   node scripts/prepare-papers.mjs [--papers a,b,c] [--staff 0x..,0x..(5)] [--out demo-data] [--ipfs local|pinata]
//
// Writes <out>/papers.json (public: CIDs + keccak256 hashes) and <out>/secrets/staff-<i>.json
// (private: that staff member's 3 shares + seed). The AES keys are never written or logged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress } from "ethers";
import {
  PAPER_LABELS,
  cidForBytes,
  encryptPaper,
  generateKey,
  paperHash,
  randomSeed,
  splitKey,
  toHex,
} from "../shared/vaultCrypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF_COUNT = 5;
const THRESHOLD = 3;
const PINATA_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

export const DEFAULT_PAPERS = PAPER_LABELS.map((l) => path.join(ROOT, "papers", `paper-${l}.md`));
export const DEFAULT_IPFS_DIR = path.join(ROOT, "frontend", "public", "ipfs");

async function uploadLocal(bytes, ipfsDir) {
  const cid = await cidForBytes(bytes);
  fs.mkdirSync(ipfsDir, { recursive: true });
  fs.writeFileSync(path.join(ipfsDir, cid), bytes);
  return cid;
}

async function uploadPinata(bytes, name, jwt) {
  if (!jwt) throw new Error("Pinata mode needs PINATA_JWT (set it in .env or the environment)");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  let res;
  try {
    res = await fetch(PINATA_URL, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
  } catch (e) {
    throw new Error(`Pinata upload of ${name} failed (network): ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Pinata upload of ${name} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Pinata returned non-JSON for ${name}: ${text.slice(0, 300)}`);
  }
  if (!body.IpfsHash) throw new Error(`Pinata response for ${name} has no IpfsHash: ${text.slice(0, 300)}`);
  return body.IpfsHash;
}

/**
 * @param {object} o
 * @param {string[]} [o.paperFiles]      3 plaintext papers (A, B, C)
 * @param {(string|null)[]} [o.staffAddresses] 5 staff addresses, or omitted (null in the files)
 * @param {string} [o.outDir]            output folder (default demo-data)
 * @param {"local"|"pinata"} [o.ipfs]    upload mode
 * @param {string} [o.ipfsDir]           local mode: where ciphertexts go (default frontend/public/ipfs)
 * @param {string} [o.pinataJwt]         pinata mode: JWT (default env PINATA_JWT)
 * @param {string} [o.gateway]           gateway written to papers.json (default env IPFS_GATEWAY or per-mode default)
 * @param {boolean} [o.quiet]
 */
export async function preparePapers({
  paperFiles = DEFAULT_PAPERS,
  staffAddresses = null,
  outDir = path.join(ROOT, "demo-data"),
  ipfs = process.env.PINATA_JWT ? "pinata" : "local",
  ipfsDir = DEFAULT_IPFS_DIR,
  pinataJwt = process.env.PINATA_JWT,
  gateway,
  quiet = false,
} = {}) {
  if (!Array.isArray(paperFiles) || paperFiles.length !== PAPER_LABELS.length) {
    throw new Error(`Expected ${PAPER_LABELS.length} paper files (A, B, C), got ${paperFiles?.length}`);
  }
  if (ipfs !== "local" && ipfs !== "pinata") throw new Error(`--ipfs must be "local" or "pinata", got "${ipfs}"`);
  let staff = Array(STAFF_COUNT).fill(null);
  if (staffAddresses && staffAddresses.length) {
    if (staffAddresses.length !== STAFF_COUNT) throw new Error(`Expected ${STAFF_COUNT} staff addresses, got ${staffAddresses.length}`);
    staff = staffAddresses.map((a) => {
      try {
        return getAddress(a);
      } catch {
        throw new Error(`Invalid staff address: ${a}`);
      }
    });
  }

  const papers = [];
  const shares = []; // shares[p][s] = hex share of paper p for staff s
  for (let p = 0; p < paperFiles.length; p++) {
    const label = PAPER_LABELS[p];
    const file = path.resolve(paperFiles[p]);
    if (!fs.existsSync(file)) throw new Error(`Paper ${label} not found: ${file}`);
    const plain = new Uint8Array(fs.readFileSync(file));

    let key = await generateKey();
    const enc = await encryptPaper(plain, path.basename(file), key);
    const pieceBytes = await splitKey(key, STAFF_COUNT, THRESHOLD);
    key.fill(0); // drop the key: from here on only the shares exist
    key = null;

    const hash = paperHash(enc);
    const cid = ipfs === "local" ? await uploadLocal(enc, ipfsDir) : await uploadPinata(enc, `exam-paper-${label}.enc`, pinataJwt);
    papers.push({ label, sourceFile: path.relative(ROOT, file).split(path.sep).join("/"), cid, hash, size: enc.length });
    shares.push(pieceBytes.map(toHex));
  }

  const manifest = {
    version: 1,
    ipfs,
    gateway: gateway ?? process.env.IPFS_GATEWAY ?? (ipfs === "local" ? "/ipfs" : "https://gateway.pinata.cloud/ipfs"),
    papers,
  };

  // NOTE: seeds are generated here as a demo simplification. In production every staff
  // member generates (and keeps) their own seed, so no single person ever knows all five.
  const secrets = staff.map((addr, s) => ({
    version: 1,
    staffIndex: s + 1,
    staffAddress: addr,
    pieces: shares.map((perPaper) => perPaper[s]),
    seed: randomSeed().toString(),
  }));

  const out = path.resolve(outDir);
  const secretsDir = path.join(out, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(out, "papers.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const sec of secrets) {
    fs.writeFileSync(path.join(secretsDir, `staff-${sec.staffIndex}.json`), JSON.stringify(sec, null, 2) + "\n");
  }

  if (!quiet) {
    console.log(`Prepared ${papers.length} encrypted papers (IPFS mode: ${ipfs})`);
    for (const p of papers) console.log(`  Paper ${p.label}: ${p.sourceFile}  ${p.size} bytes\n    cid  ${p.cid}\n    hash ${p.hash}`);
    console.log(`Manifest:     ${path.join(out, "papers.json")}`);
    console.log(`Staff files:  ${secretsDir}${path.sep}staff-1..${STAFF_COUNT}.json (keep private; ${THRESHOLD} of ${STAFF_COUNT} unlock a paper)`);
    if (ipfs === "local") console.log(`Ciphertexts:  ${ipfsDir}`);
  }
  return { papers, manifest, secrets };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? a.split(/=(.*)/s) : [a, undefined];
    const val = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--papers") opts.paperFiles = val().split(",").map((s) => s.trim());
    else if (flag === "--staff") opts.staffAddresses = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--out") opts.outDir = val();
    else if (flag === "--ipfs") opts.ipfs = val();
    else if (flag === "-h" || flag === "--help") opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
  } catch {
    /* dotenv optional */
  }
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("usage: node scripts/prepare-papers.mjs [--papers a,b,c] [--staff 0x..,0x..(5)] [--out demo-data] [--ipfs local|pinata]");
      process.exit(0);
    }
    if (opts.outDir) opts.outDir = path.resolve(opts.outDir);
    await preparePapers(opts);
  } catch (e) {
    console.error(`prepare-papers: ${e.message}`);
    process.exit(1);
  }
}
