// Everything that talks to the blockchain: providers, contracts, the polling
// hook that keeps a snapshot of the vault state, and custom-error decoding.
import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, Interface, JsonRpcProvider, Network } from "ethers";
import { deployment } from "./deployment.js";

export const POLL_MS = 2500;

// ------------------------------------------------------------------ providers & contracts

/** Read-only provider straight to the RPC node, so the portal works with no wallet. */
export const readProvider = deployment
  ? new JsonRpcProvider(deployment.rpcUrl, Network.from(deployment.chainId), { staticNetwork: true, cacheTimeout: -1 })
  : null;

const vaultAbi = deployment?.abi?.ExamVault ?? [];
const tokenAbi = deployment?.abi?.CollegeAccessToken ?? [];

export const vaultIface = new Interface(vaultAbi);
const tokenIface = new Interface(tokenAbi);

export const vaultRead = deployment ? new Contract(deployment.vault, vaultAbi, readProvider) : null;
const tokenRead = deployment ? new Contract(deployment.accessToken, tokenAbi, readProvider) : null;

/** ExamVault connected to a signer, for sending transactions. */
export function vaultWrite(signer) {
  return new Contract(deployment.vault, vaultAbi, signer);
}

// ------------------------------------------------------------------ state snapshot

// Hardhat demos fast-forward time (evm_increaseTime), so the chain clock can be
// ahead of the wall clock. We remember the largest gap seen and add it to Date.now().
let chainClockOffset = 0;
let immutables = null; // values that never change: read once
let startTime = null; // timestamp of the deploy block, for the dial's progress ring

async function loadImmutables() {
  if (!immutables) {
    const [admin, minStake, seedWindow, revealWindow] = await Promise.all([
      vaultRead.admin(),
      vaultRead.minStake(),
      vaultRead.seedWindow(),
      vaultRead.revealWindow(),
    ]);
    immutables = { admin, minStake, seedWindow: Number(seedWindow), revealWindow: Number(revealWindow) };
  }
  if (startTime === null) {
    const block = deployment.deployBlock != null ? await readProvider.getBlock(Number(deployment.deployBlock)) : null;
    startTime = block ? Number(block.timestamp) : 0;
  }
  return immutables;
}

/** Reads everything the screens need in one go (ethers batches the RPC calls). */
export async function loadVaultState() {
  const fixed = await loadImmutables();
  const [
    examTime,
    seedsCommitted,
    seedsRevealed,
    paperSelected,
    selectedPaper,
    selectedAt,
    piecesRevealed,
    postponed,
    slashedTotal,
    unlocked,
    dutiesOver,
    staffList,
    collegeList,
    papers,
    downloads,
    block,
  ] = await Promise.all([
    vaultRead.examTime(),
    vaultRead.seedsCommitted(),
    vaultRead.seedsRevealed(),
    vaultRead.paperSelected(),
    vaultRead.selectedPaper(),
    vaultRead.selectedAt(),
    vaultRead.piecesRevealed(),
    vaultRead.postponed(),
    vaultRead.slashedTotal(),
    vaultRead.isUnlocked(),
    vaultRead.dutiesOver(),
    vaultRead.getStaffList(),
    vaultRead.getCollegeList(),
    vaultRead.getPapers(),
    vaultRead.getDownloads(),
    readProvider.getBlock("latest"),
  ]);

  const staff = await Promise.all(
    staffList.map(async (address) => {
      const [s, commits] = await Promise.all([vaultRead.getStaff(address), vaultRead.getPieceCommits(address)]);
      return {
        address,
        index: Number(s.index),
        stake: s.stake,
        piecesCommitted: s.piecesCommitted,
        seedCommitted: s.seedCommitted,
        seedRevealed: s.seedRevealed,
        pieceRevealed: s.pieceRevealed,
        penalised: s.penalised,
        withdrawn: s.withdrawn,
        pieceCommits: [...commits],
        // Same rule as ExamVault.missedDuty()
        missedDuty: !s.seedRevealed || (paperSelected && !s.pieceRevealed),
      };
    }),
  );

  const colleges = await Promise.all(
    collegeList.map(async (address) => {
      const [c, balance] = await Promise.all([vaultRead.getCollege(address), tokenRead.balanceOf(address)]);
      return { address, name: c.name, tokenId: Number(c.tokenId), holdsToken: balance > 0n };
    }),
  );

  let revealed = { who: [], pieces: [] };
  if (piecesRevealed > 0n) {
    const r = await vaultRead.getRevealedPieces();
    revealed = { who: [...r.who], pieces: [...r.pieces] };
  }

  const chainNow = Number(block.timestamp);
  chainClockOffset = Math.max(chainClockOffset, chainNow - Date.now() / 1000);

  return {
    ...fixed,
    startTime,
    examTime: Number(examTime),
    seedsCommitted: Number(seedsCommitted),
    seedsRevealed: Number(seedsRevealed),
    paperSelected,
    selectedPaper: Number(selectedPaper),
    selectedAt: Number(selectedAt),
    piecesRevealed: Number(piecesRevealed),
    postponed,
    slashedTotal,
    unlocked,
    dutiesOver,
    staff,
    colleges,
    papers: { hashes: [...papers.hashes], cids: [...papers.cids] },
    downloads: downloads.map((d) => ({ college: d.college, tokenId: Number(d.tokenId), time: Number(d.time) })),
    revealed,
    blockNumber: block.number,
  };
}

/** Polls the vault every POLL_MS. `refresh()` reloads right away (e.g. after a tx). */
export function useVaultState() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await loadVaultState();
      if (alive.current) {
        setState(s);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, []);

  useEffect(() => {
    if (!vaultRead) return undefined;
    alive.current = true;
    let timer;
    const tick = async () => {
      await refresh();
      if (alive.current) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  return { state, error, refresh };
}

/** Current chain time in unix seconds, ticking every second. */
export function useChainNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000 + chainClockOffset));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000 + chainClockOffset)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ------------------------------------------------------------------ phase helpers

/** "NOT SET" | "LOCKED" | "PICKING" | "REVEALING" | "UNLOCKED" | "POSTPONED" */
export function examPhase(s, now) {
  if (!s || s.examTime === 0) return "NOT SET";
  if (s.postponed) return "POSTPONED";
  if (s.unlocked) return "UNLOCKED";
  if (s.paperSelected) return "REVEALING";
  if (now >= s.examTime) return "PICKING";
  return "LOCKED";
}

/** Same rule as ExamVault.selectPaper(). */
export function canSelectPaper(s, now) {
  if (!s || s.examTime === 0 || s.paperSelected || s.postponed || now < s.examTime) return false;
  if (s.seedsRevealed < 3) return false;
  return s.seedsRevealed === s.seedsCommitted || now >= s.examTime + s.seedWindow;
}

/** Label for an address: Admin, Staff N, college name or Viewer. */
export function roleOf(address, s) {
  if (!address || !s) return "Viewer";
  const a = address.toLowerCase();
  if (s.admin.toLowerCase() === a) return "Admin";
  const st = s.staff.find((x) => x.address.toLowerCase() === a);
  if (st) return `Staff ${st.index}`;
  const c = s.colleges.find((x) => x.address.toLowerCase() === a);
  if (c) return c.name || "College";
  return "Viewer";
}

// ------------------------------------------------------------------ errors

const FRIENDLY = {
  NotAdmin: "Only the admin can do that.",
  NotStaff: "This wallet is not one of the 5 keyholders.",
  NotCollege: "This wallet is not a registered college.",
  ExamAlreadySet: "The exam has already been set.",
  ExamNotSet: "The admin has not set the exam time yet.",
  StakeTooLow: "Lock the minimum deposit first.",
  ZeroDeposit: "The deposit cannot be zero.",
  AlreadyCommitted: "You have already saved this.",
  TooLate: "Too late: the exam time has passed.",
  TooEarly: "Too early: wait for the countdown to finish.",
  NotCommitted: "You did not save this before the exam time.",
  AlreadyRevealed: "You have already revealed this.",
  HashMismatch: "This does not match what you saved earlier. Check that you loaded the right key file.",
  NotEnoughSeeds: "At least 3 secret numbers must be revealed before a paper can be picked.",
  AlreadySelected: "A paper has already been picked.",
  NotSelected: "No paper has been picked yet.",
  WindowClosed: "The time window for this step has closed.",
  HasToken: "This college already has an access token.",
  NoToken: "This wallet does not hold a college access token.",
  PaperLocked: "The paper is still locked: fewer than 3 keys have been revealed.",
  ExamPostponedErr: "The exam was postponed.",
  NothingToPenalise: "There is nothing to penalise for this keyholder.",
  DutiesNotOver: "Wait until the reveal windows have closed.",
  AlreadyWithdrawn: "The deposit was already withdrawn.",
  TransferFailed: "Sending the deposit back failed.",
  Soulbound: "Access tokens are soulbound and cannot be transferred.",
};

/** Finds revert data (0x...) anywhere inside an ethers / MetaMask error object. */
function findRevertData(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (typeof err === "string") return /^0x[0-9a-fA-F]{8,}$/.test(err) ? err : null;
  if (typeof err !== "object") return null;
  for (const key of ["data", "error", "info", "cause", "originalError"]) {
    const found = findRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Turns any transaction / call error into a sentence for the user. */
export function friendlyError(err) {
  if (!err) return "";
  if (err.code === "ACTION_REJECTED" || err.info?.error?.code === 4001) return "You rejected the request in your wallet.";

  let name = err.revert?.name;
  if (!name) {
    const data = findRevertData(err);
    if (data) {
      for (const iface of [vaultIface, tokenIface]) {
        try {
          const parsed = iface.parseError(data);
          if (parsed) {
            name = parsed.name;
            break;
          }
        } catch {
          /* not this contract's error */
        }
      }
    }
  }
  if (name) return FRIENDLY[name] ?? `The contract refused: ${name}.`;
  if (err.code === "NETWORK_ERROR" || /failed to fetch|ECONNREFUSED/i.test(err.message ?? "")) {
    return "Cannot reach the blockchain node. Is `npm run node` running?";
  }
  return err.shortMessage || err.message || String(err);
}
