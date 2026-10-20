#!/usr/bin/env node
// Demo reveal: plays the staff (and optionally a college) at exam time.
//
//   npm run demo:reveal                                   staff 1,2,3 reveal; waits for real exam time
//   npm run demo:reveal -- --fast --penalise --download   jump time on a Hardhat node, do everything
//
// Options:
//   --staff 1,2,3   which staff reveal (default 1,2,3, so 4 and 5 miss the window)
//   --fast          on a Hardhat node, jump the chain clock instead of waiting
//   --download      as college 6: log the download, fetch + verify + decrypt the paper;
//                   also shows college 7 (no token) being refused
//   --penalise      after the reveal window, slash every staff member who missed a duty
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { combineKey, decryptPaper, paperHash, PAPER_LABELS } from "../shared/vaultCrypto.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const DATA = path.resolve(ROOT, process.env.DEMO_DATA_DIR || "demo-data");
const LABELS = PAPER_LABELS ?? ["A", "B", "C"];

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const FAST = flag("--fast");
const PENALISE = flag("--penalise") || flag("--penalize");
const DOWNLOAD = flag("--download");
let revealers = [1, 2, 3];
const si = argv.findIndex((a) => a === "--staff" || a.startsWith("--staff="));
if (si >= 0) {
  const raw = argv[si].includes("=") ? argv[si].split("=")[1] : argv[si + 1];
  revealers = String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  if (!revealers.length) {
    console.error("--staff expects a list like 1,2,3 (numbers 1-5)");
    process.exit(2);
  }
}

// ------------------------------------------------------------------ helpers
let stepNo = 0;
const step = (msg) => console.log(`\n[${++stepNo}] ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (wei) => `${ethers.formatEther(wei)} ETH`;
const fmtTime = (t) => new Date(Number(t) * 1000).toLocaleTimeString();

function readJson(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)}. ${hint}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Decodes a revert into { name, text } using the contract ABI. */
function decode(err, iface) {
  if (err?.revert?.name) return { name: err.revert.name, text: `${err.revert.name}(${err.revert.args.join(", ")})` };
  const candidates = [err?.data, err?.info?.error?.data, err?.error?.data, err?.info?.error?.data?.data];
  for (const data of candidates) {
    if (typeof data !== "string" || data.length < 10) continue;
    try {
      const p = iface.parseError(data);
      if (p) return { name: p.name, text: `${p.name}(${p.args.join(", ")})` };
    } catch { /* try next */ }
  }
  const msg = err?.shortMessage || err?.message || String(err);
  const m = /custom error '([A-Za-z0-9_]+)/.exec(msg) || /reverted with custom error '([A-Za-z0-9_]+)/.exec(msg);
  return { name: m?.[1] ?? "Unknown", text: msg };
}

async function main() {
  const dep = readJson(path.join(DATA, "deployment.json"), 'Run "npm run demo:setup" first.');
  const vaultArt = readJson(
    path.join(ROOT, "artifacts", "contracts", "ExamVault.sol", "ExamVault.json"),
    'Run "npm run compile" first.',
  );
  const iface = new ethers.Interface(vaultArt.abi);
  const rpcUrl = process.env.RPC_URL || dep.rpcUrl || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 }); // no response cache: the same call must be re-run after the clock jumps
  try {
    await provider.getNetwork();
  } catch {
    console.error(`Cannot reach a node at ${rpcUrl}. Start it with "npm run node", then "npm run demo:setup".`);
    provider.destroy();
    process.exit(1);
  }
  if ((await provider.getCode(dep.vault)) === "0x") {
    console.error(`No ExamVault at ${dep.vault} on ${rpcUrl}. Was the node restarted? Run "npm run demo:setup" again.`);
    process.exit(1);
  }

  let isHardhat = false;
  try {
    isHardhat = /hardhat/i.test(await provider.send("web3_clientVersion", []));
  } catch { /* not hardhat */ }
  if (FAST && !isHardhat) {
    console.error("--fast needs a Hardhat node (it uses evm_increaseTime). Run without --fast to wait in real time.");
    process.exit(1);
  }

  const accounts = await provider.listAccounts();
  const byAddr = (a) => accounts.find((s) => s.address.toLowerCase() === a.toLowerCase());
  const admin = byAddr(dep.accounts.admin);
  const staff = dep.accounts.staff.map(byAddr);
  if (!admin || staff.some((s) => !s)) {
    console.error("The demo accounts are not unlocked on this node. Use the Hardhat node started by \"npm run node\".");
    process.exit(1);
  }
  const vault = new ethers.Contract(dep.vault, vaultArt.abi, admin);
  const asStaff = (n) => vault.connect(staff[n - 1]);

  /** Sends a tx, waits for it, and returns null, or a decoded error. */
  async function tryTx(fn) {
    try {
      const tx = await fn();
      await tx.wait();
      return null;
    } catch (err) {
      return decode(err, iface);
    }
  }
  async function mustTx(label, fn) {
    const e = await tryTx(fn);
    if (e) {
      console.error(`    ✗ ${label} reverted: ${e.text}`);
      provider.destroy();
      process.exit(1);
    }
  }

  /** Current chain time: the lowest timestamp the next transaction can get.
   *  Hardhat stamps a new block (and gas estimation) with wall clock + its time offset;
   *  evm_increaseTime(0) returns that offset without changing it. */
  async function chainNow() {
    if (isHardhat) {
      const offset = BigInt(await provider.send("evm_increaseTime", [0]));
      return BigInt(Math.floor(Date.now() / 1000)) + offset;
    }
    return BigInt((await provider.getBlock("latest")).timestamp);
  }
  /** Gets the chain clock to `target` (unix seconds): jump with --fast, else count down. */
  async function reach(target, label) {
    let now = await chainNow();
    if (now >= target) return;
    if (FAST) {
      // +2s margin: the wall-clock estimate in chainNow() can lag the next block's stamp.
      const delta = target - now + 2n;
      await provider.send("evm_increaseTime", [Number(delta)]);
      await provider.send("evm_mine", []);
      info(`⏩ fast-forwarded the chain clock ${delta}s to ${label} (${fmtTime(target)})`);
      return;
    }
    // Real wait: count down on the wall clock, then confirm on chain time.
    const offset = Number(now) - Date.now() / 1000;
    for (;;) {
      const left = Math.ceil(Number(target) - (Date.now() / 1000 + offset));
      if (left <= 0) break;
      const mm = String(Math.floor(left / 60)).padStart(2, "0");
      const ss = String(left % 60).padStart(2, "0");
      process.stdout.write(`\r    ⏳ ${label} in ${mm}:${ss}   `);
      await sleep(1000);
    }
    process.stdout.write("\n");
    while ((now = await chainNow()) < target + 1n) await sleep(1000);
  }

  const secretFor = (n) => {
    const addr = staff[n - 1].address.toLowerCase();
    const dir = path.join(DATA, "secrets");
    for (const f of fs.readdirSync(dir)) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (s.staffAddress?.toLowerCase() === addr) return s;
    }
    throw new Error(`No secret file for staff ${n} in demo-data/secrets`);
  };

  console.log("=================================================================");
  console.log(` Exam day — "${dep.examTitle}"`);
  console.log(` Revealing staff: ${revealers.join(", ")}${FAST ? "   (fast mode: chain clock jumps)" : ""}`);
  console.log("=================================================================");

  const examTime = await vault.examTime();
  const seedWindow = await vault.seedWindow();
  const revealWindow = await vault.revealWindow();

  // ------------------------------------------------------------ 0. not yet!
  const before = await chainNow();
  if (before < examTime) {
    step("Before exam time the vault refuses everything");
    const s1 = secretFor(revealers[0]);
    const e = await tryTx(() => asStaff(revealers[0]).revealSeed(BigInt(s1.seed)));
    info(`Staff ${revealers[0]} tries revealSeed early → rejected with ${e?.name ?? "?"}`);
  }

  // ------------------------------------------------------------ 1. wait
  step(`Waiting for exam time ${fmtTime(examTime)}`);
  await reach(examTime, "exam time");
  info("🔔 Exam time reached.");

  // ------------------------------------------------------------ 2. seeds
  step("Staff reveal their secret seeds (each must match its commitment)");
  for (const n of revealers) {
    const st = await vault.getStaff(staff[n - 1].address);
    if (st.seedRevealed) { info(`Staff ${n}: seed already revealed`); continue; }
    if (!st.seedCommitted) { info(`Staff ${n}: never committed a seed — cannot reveal`); continue; }
    const seed = BigInt(secretFor(n).seed);
    const e = await tryTx(() => asStaff(n).revealSeed(seed));
    info(e ? `Staff ${n}: ✗ ${e.text}` : `Staff ${n}: seed ${seed.toString().slice(0, 12)}… ✓`);
  }
  const missing = [1, 2, 3, 4, 5].filter((n) => !revealers.includes(n));
  if (missing.length) info(`Staff ${missing.join(", ")} stay silent (they will miss the window).`);
  info(`Seeds revealed: ${await vault.seedsRevealed()} of ${await vault.seedsCommitted()} committed`);

  // ------------------------------------------------------------ 3. select
  step("Picking the paper: keccak256(XOR of all revealed seeds) mod 3");
  if (!(await vault.paperSelected())) {
    const allIn = (await vault.seedsRevealed()) === (await vault.seedsCommitted());
    if (!allIn) {
      info("Not every committed seed is in, so selectPaper waits until the seed window closes");
      info("(stops a late staff member from seeing the result first and choosing whether to reveal).");
      await reach(examTime + seedWindow, "seed window end");
    }
    await mustTx("selectPaper", () => vault.selectPaper());
  }
  const sel = Number(await vault.selectedPaper());
  const selectedAt = await vault.selectedAt();
  console.log(`\n    🎲 Paper ${LABELS[sel]} was chosen. Only paper ${LABELS[sel]}'s pieces will be revealed.`);
  info(`Reveal window: ${revealWindow}s, until ${fmtTime(selectedAt + revealWindow)}`);

  // ------------------------------------------------------------ 4. pieces
  step(`Staff reveal their key piece for paper ${LABELS[sel]}`);
  let tamperShown = false;
  for (const n of revealers) {
    const st = await vault.getStaff(staff[n - 1].address);
    if (st.pieceRevealed) { info(`Staff ${n}: piece already revealed`); continue; }
    const piece = secretFor(n).pieces[sel];
    if (!tamperShown) {
      tamperShown = true;
      const bytes = ethers.getBytes(piece);
      bytes[bytes.length - 1] ^= 0xff;
      const fake = ethers.hexlify(bytes);
      const e = await tryTx(() => asStaff(n).revealPiece(fake));
      console.log(`\n    🚫 Staff ${n} first submits a TAMPERED piece (last byte flipped)`);
      console.log(`       → contract rejected it: ${e ? e.name : "NOT rejected?!"}`);
      console.log("       (its hash does not match the commitment posted before the exam)\n");
    }
    const e = await tryTx(() => asStaff(n).revealPiece(piece));
    info(e ? `Staff ${n}: ✗ ${e.text}` : `Staff ${n}: real piece ${piece.slice(0, 14)}… ✓ matches commitment`);
  }
  const revealed = Number(await vault.piecesRevealed());
  if (await vault.isUnlocked()) {
    console.log("\n    ██████████████████████████████████████████");
    console.log(`    ██   UNLOCKED — paper ${LABELS[sel]} (${revealed} of 5 pieces)   ██`);
    console.log("    ██████████████████████████████████████████");
  } else {
    console.log(`\n    🔒 Still locked: ${revealed} of 3 required pieces revealed.`);
  }

  // ------------------------------------------------------------ 5. download
  if (DOWNLOAD) {
    step("Colleges download the paper");
    const cols = dep.accounts.colleges;
    const withToken = cols.find((c) => c.token);
    const noToken = cols.find((c) => !c.token);
    if (noToken) {
      const e = await tryTx(() => vault.connect(byAddr(noToken.address)).logDownload());
      info(`${noToken.name} (no token) → logDownload ${e ? `rejected with ${e.name}` : "unexpectedly succeeded"}`);
    }
    if (withToken) {
      const c = byAddr(withToken.address);
      const e = await tryTx(() => vault.connect(c).logDownload());
      if (e) {
        info(`${withToken.name} → logDownload rejected with ${e.text}`);
      } else {
        const tokenId = (await vault.getCollege(withToken.address)).tokenId;
        info(`${withToken.name} (token #${tokenId}) → download logged on-chain ✓`);
        await downloadAndDecrypt(vault, sel, dep);
      }
    }
  }

  // ------------------------------------------------------------ 6. penalise
  if (PENALISE) {
    step("Penalties for staff who missed a duty (anyone may call penalise)");
    const end = selectedAt + revealWindow;
    info(`Reveal window ends at ${fmtTime(end)}`);
    await reach(end, "reveal window end");
    const beforeStakes = [];
    for (const s of staff) beforeStakes.push((await vault.getStaff(s.address)).stake);
    for (const [i, s] of staff.entries()) {
      const st = await vault.getStaff(s.address);
      if (st.penalised || !(await vault.missedDuty(s.address))) continue;
      const e = await tryTx(() => vault.penalise(s.address));
      if (e) info(`penalise(staff ${i + 1}) → ${e.text}`);
    }
    console.log("\n    Staff   revealed seed/piece   stake before   stake after");
    for (const [i, s] of staff.entries()) {
      const st = await vault.getStaff(s.address);
      const mark = st.penalised ? "  ⚠ slashed" : "";
      console.log(
        `    ${String(i + 1).padEnd(7)} ${(st.seedRevealed ? "yes" : "no ").padEnd(4)}/ ${(st.pieceRevealed ? "yes" : "no").padEnd(14)} ` +
          `${eth(beforeStakes[i]).padEnd(14)} ${eth(st.stake)}${mark}`,
      );
    }
    info(`Total slashed (locked in the contract forever): ${eth(await vault.slashedTotal())}`);
  }

  console.log("\nDone. Open the portal (npm run portal) to see the same state on the Home, Staff and College screens.");
  provider.destroy();
}

async function downloadAndDecrypt(vault, sel, dep) {
  const [hashes, cids] = await vault.getPapers();
  const cid = cids[sel];
  let bytes;
  const local = path.join(ROOT, "frontend", "public", "ipfs", cid);
  if (fs.existsSync(local)) {
    bytes = new Uint8Array(fs.readFileSync(local));
    info(`Fetched ciphertext from local IPFS folder: frontend/public/ipfs/${cid.slice(0, 16)}…`);
  } else {
    const gw = dep.ipfsGateway && /^https?:/.test(dep.ipfsGateway) ? dep.ipfsGateway : "https://gateway.pinata.cloud/ipfs/";
    const url = gw.endsWith("/") ? gw + cid : `${gw}/${cid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status} ${url}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    info(`Fetched ciphertext from ${url}`);
  }
  const h = paperHash(bytes);
  const ok = h.toLowerCase() === hashes[sel].toLowerCase();
  info(`Hash check: ${h.slice(0, 18)}… vs on-chain ${hashes[sel].slice(0, 18)}… → ${ok ? "MATCH ✓" : "MISMATCH ✗"}`);
  if (!ok) return;
  const [who, pieces] = await vault.getRevealedPieces();
  const key = await combineKey(pieces.map((p) => ethers.getBytes(p)));
  info(`Rebuilt the AES key off-chain from ${who.length} revealed Shamir pieces`);
  const plain = await decryptPaper(bytes, key);
  const text = new TextDecoder().decode(plain.bytes);
  info(`Decrypted ${plain.fileName} (${plain.bytes.length} bytes)`);
  console.log("\n    ---------------- decrypted paper (first lines) ----------------");
  for (const line of text.split(/\r?\n/).slice(0, 8)) console.log(`    | ${line}`);
  console.log("    ---------------------------------------------------------------");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
