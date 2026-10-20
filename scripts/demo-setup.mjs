#!/usr/bin/env node
// Demo setup: deploys ExamVault on a running local node and walks the exam
// through every "before exam time" step, printing each one for the viva.
//
//   terminal 1:  npm run node
//   terminal 2:  npm run demo:setup            (add -- --no-commit to commit from the portal)
//
// Env (all optional): RPC_URL, MIN_STAKE (ETH), SEED_WINDOW (s), REVEAL_WINDOW (s),
// EXAM_DELAY (s), PINATA_JWT (upload to Pinata instead of the local IPFS folder),
// DEMO_DATA_DIR (default demo-data), FRONTEND_DEPLOYMENT (default frontend/src/deployment.json).
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { preparePapers } from "./prepare-papers.mjs";
import { seedCommitment, pieceCommitment } from "../shared/vaultCrypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const MIN_STAKE = process.env.MIN_STAKE || "0.5";
const SEED_WINDOW = BigInt(process.env.SEED_WINDOW || 120);
const REVEAL_WINDOW = BigInt(process.env.REVEAL_WINDOW || 600);
const EXAM_DELAY = BigInt(process.env.EXAM_DELAY || 120);
const STAKE_AMOUNT = "1";
const EXAM_TITLE = "Data Structures — Semester 5";
const NO_COMMIT = process.argv.includes("--no-commit");

const COLLEGES = [
  { account: 6, name: "Govt. College of Engineering", token: true },
  { account: 7, name: "City Arts College", token: false },
];

let stepNo = 0;
const step = (msg) => console.log(`\n[${++stepNo}] ${msg}`);
const info = (msg) => console.log(`    ${msg}`);

function loadArtifact(name) {
  const file = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)} — run "npm run compile" first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Turns a revert into "ErrorName(args)" using the contract ABI. */
function explain(err, iface) {
  if (err?.revert?.name) return `${err.revert.name}(${err.revert.args.join(", ")})`;
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const p = iface.parseError(data);
      if (p) return `${p.name}(${p.args.join(", ")})`;
    } catch { /* fall through */ }
  }
  return err?.shortMessage || err?.message || String(err);
}

async function send(label, iface, fn) {
  try {
    const tx = await fn();
    const rcpt = await tx.wait();
    return rcpt;
  } catch (err) {
    console.error(`\n    ✗ ${label} failed: ${explain(err, iface)}`);
    process.exit(1);
  }
}

async function main() {
  console.log("=================================================================");
  console.log(" Time-locked exam papers — demo setup");
  console.log("=================================================================");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  let network;
  try {
    network = await provider.getNetwork();
  } catch {
    console.error(`\nCannot reach a blockchain node at ${RPC_URL}.`);
    console.error(`Start one first in another terminal:  npm run node`);
    console.error(`(or set RPC_URL to point at a different node)`);
    provider.destroy();
    process.exit(1);
  }
  const chainId = Number(network.chainId);

  const accounts = await provider.listAccounts();
  if (accounts.length < 8) {
    console.error(`The node at ${RPC_URL} exposes ${accounts.length} unlocked accounts; the demo needs 8 (a Hardhat node has 20).`);
    process.exit(1);
  }
  const signer = (i) => accounts[i];
  const admin = signer(0);
  const staff = [1, 2, 3, 4, 5].map(signer);
  const colleges = COLLEGES.map((c) => ({ ...c, signer: signer(c.account) }));

  info(`Node: ${RPC_URL} (chain ${chainId})`);
  info(`Admin: account #0 ${admin.address}`);

  // ------------------------------------------------------------- 1. deploy
  const vaultArt = loadArtifact("ExamVault");
  const tokenArt = loadArtifact("CollegeAccessToken");
  const iface = new ethers.Interface(vaultArt.abi);

  step(`Deploying ExamVault (min stake ${MIN_STAKE} ETH, seed window ${SEED_WINDOW}s, reveal window ${REVEAL_WINDOW}s)`);
  const factory = new ethers.ContractFactory(vaultArt.abi, vaultArt.bytecode, admin);
  let vault;
  try {
    vault = await factory.deploy(ethers.parseEther(MIN_STAKE), SEED_WINDOW, REVEAL_WINDOW);
    await vault.waitForDeployment();
  } catch (err) {
    console.error(`    ✗ deploy failed: ${explain(err, iface)}`);
    process.exit(1);
  }
  const vaultAddr = await vault.getAddress();
  const deployRcpt = await vault.deploymentTransaction().wait();
  const tokenAddr = await vault.accessToken();
  info(`ExamVault          ${vaultAddr}  (block ${deployRcpt.blockNumber})`);
  info(`CollegeAccessToken ${tokenAddr}  (deployed by the vault, so only the vault can mint)`);

  // ------------------------------------------------------------- 2. register
  step("Admin registers the 5 staff keyholders");
  for (const [i, s] of staff.entries()) {
    await send(`registerStaff #${i + 1}`, iface, () => vault.registerStaff(s.address));
    info(`Staff ${i + 1}: account #${i + 1} ${s.address}`);
  }

  step("Admin registers 2 colleges");
  for (const c of colleges) {
    await send(`registerCollege ${c.name}`, iface, () => vault.registerCollege(c.signer.address, c.name));
    info(`${c.name}: account #${c.account} ${c.signer.address}`);
  }

  // ------------------------------------------------------------- 3. papers
  const ipfsMode = process.env.PINATA_JWT ? "pinata" : "local";
  step(`Setter encrypts papers A, B, C, splits each key into 5 Shamir pieces and uploads the ciphertexts (${ipfsMode === "pinata" ? "Pinata IPFS" : "local IPFS folder frontend/public/ipfs"})`);
  const outDir = path.resolve(ROOT, process.env.DEMO_DATA_DIR || "demo-data");
  const prepared = await preparePapers({
    paperFiles: ["A", "B", "C"].map((l) => path.join(ROOT, "papers", `paper-${l}.md`)),
    staffAddresses: staff.map((s) => s.address),
    outDir,
    ipfs: ipfsMode,
    quiet: true,
  });
  for (const p of prepared.papers) {
    info(`Paper ${p.label}: ${p.size} bytes encrypted · CID ${p.cid}`);
    info(`         fingerprint (keccak256) ${p.hash}`);
  }
  info(`Staff secret files written to ${path.relative(ROOT, path.join(outDir, "secrets"))}${path.sep}staff-<n>.json`);
  info("(the setter hands each file to one staff member, then deletes the key)");

  // ------------------------------------------------------------- 4. setExam
  const latest = await provider.getBlock("latest");
  const examTime = BigInt(latest.timestamp) + EXAM_DELAY;
  step(`Admin locks the exam time (now + ${EXAM_DELAY}s, measured on chain time) and the 3 fingerprints`);
  await send("setExam", iface, () =>
    vault.setExam(
      examTime,
      prepared.papers.map((p) => p.hash),
      prepared.papers.map((p) => p.cid),
    ),
  );
  info(`Exam time: ${new Date(Number(examTime) * 1000).toLocaleString()}  (unix ${examTime})`);
  info("This can never be changed again — setExam only runs once.");

  // ------------------------------------------------------------- 5. stake
  step(`Each staff member stakes ${STAKE_AMOUNT} ETH (test ETH) as a deposit`);
  for (const [i, s] of staff.entries()) {
    const v = vault.connect(s);
    await send(`stake staff ${i + 1}`, iface, () => v.stake({ value: ethers.parseEther(STAKE_AMOUNT) }));
    info(`Staff ${i + 1} staked ${STAKE_AMOUNT} ETH`);
  }

  // ------------------------------------------------------------- 6. commit
  if (NO_COMMIT) {
    step("Skipping commits (--no-commit): each staff member commits from the portal Staff screen");
    info(`Use the files in demo-data/secrets/ before ${new Date(Number(examTime) * 1000).toLocaleTimeString()}.`);
  } else {
    step("Each staff member commits: hashes of their 3 key pieces (A/B/C) + hash of a secret seed");
    for (const [i, s] of staff.entries()) {
      const secret = loadSecret(outDir, prepared, i, s.address);
      const commits = secret.pieces.map((piece, paper) => pieceCommitment(vaultAddr, s.address, paper, piece));
      const seedCommit = seedCommitment(vaultAddr, s.address, BigInt(secret.seed));
      const v = vault.connect(s);
      await send(`commitPieces staff ${i + 1}`, iface, () => v.commitPieces(commits));
      await send(`commitSeed staff ${i + 1}`, iface, () => v.commitSeed(seedCommit));
      info(`Staff ${i + 1}: pieces ${commits.map((c) => c.slice(0, 10) + "…").join(" ")}  seed ${seedCommit.slice(0, 10)}…`);
    }
    info("Only hashes go on-chain. The pieces and seeds stay secret until exam time.");
  }

  // ------------------------------------------------------------- 7. token
  step("Admin mints a soulbound access token for one college");
  for (const c of colleges) {
    if (c.token) {
      await send(`mintAccessToken ${c.name}`, iface, () => vault.mintAccessToken(c.signer.address));
      const col = await vault.getCollege(c.signer.address);
      info(`${c.name} → token #${col.tokenId} (cannot be transferred)`);
    } else {
      info(`${c.name} → no token (shows that a college without a token cannot download)`);
    }
  }

  // ------------------------------------------------------------- 8. files
  step("Writing deployment files");
  const papersJsonPath = path.join(outDir, "papers.json");
  const papersJson = fs.existsSync(papersJsonPath) ? JSON.parse(fs.readFileSync(papersJsonPath, "utf8")) : {};
  const base = {
    chainId,
    rpcUrl: RPC_URL,
    vault: vaultAddr,
    accessToken: tokenAddr,
    deployBlock: deployRcpt.blockNumber,
    ipfsGateway: papersJson.gateway ?? process.env.IPFS_GATEWAY ?? "/ipfs/",
    examTitle: EXAM_TITLE,
  };
  const frontendFile = path.resolve(ROOT, process.env.FRONTEND_DEPLOYMENT || "frontend/src/deployment.json");
  fs.mkdirSync(path.dirname(frontendFile), { recursive: true });
  fs.writeFileSync(
    frontendFile,
    JSON.stringify({ ...base, abi: { ExamVault: vaultArt.abi, CollegeAccessToken: tokenArt.abi } }, null, 2),
  );
  const demoFile = path.join(outDir, "deployment.json");
  fs.writeFileSync(
    demoFile,
    JSON.stringify(
      {
        ...base,
        examTime: Number(examTime),
        minStake: MIN_STAKE,
        seedWindow: Number(SEED_WINDOW),
        revealWindow: Number(REVEAL_WINDOW),
        accounts: {
          admin: admin.address,
          staff: staff.map((s) => s.address),
          colleges: colleges.map((c) => ({ name: c.name, address: c.signer.address, account: c.account, token: c.token })),
        },
      },
      null,
      2,
    ),
  );
  info(path.relative(ROOT, frontendFile));
  info(path.relative(ROOT, demoFile));

  // ------------------------------------------------------------- done
  const secs = Number(examTime) - Math.floor(Date.now() / 1000);
  console.log("\n=================================================================");
  console.log(` Vault is LOCKED. Exam "${EXAM_TITLE}"`);
  console.log(` opens at ${new Date(Number(examTime) * 1000).toLocaleTimeString()} (about ${Math.max(secs, 0)}s from now).`);
  console.log("=================================================================");
  console.log("Next steps:");
  console.log("  npm run portal                                   open the printed URL and watch the countdown");
  if (NO_COMMIT) console.log("  Staff screen: commit pieces + seed for each staff member before exam time");
  console.log("  npm run demo:reveal                              staff 1-3 reveal at exam time (real wait)");
  console.log("  npm run demo:reveal -- --fast --penalise --download   jump time, reveal, penalise, download");
  provider.destroy();
}

/** Picks this staff member's secret (from preparePapers' return value or demo-data/secrets). */
function loadSecret(outDir, prepared, i, address) {
  const fromMem = prepared.secrets?.find((s) => s.staffAddress?.toLowerCase() === address.toLowerCase());
  if (fromMem) return fromMem;
  const dir = path.join(outDir, "secrets");
  for (const f of fs.readdirSync(dir)) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (s.staffAddress?.toLowerCase() === address.toLowerCase()) return s;
  }
  throw new Error(`No secret file for staff ${i + 1} (${address})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
