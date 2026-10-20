import { useEffect, useMemo, useState } from "react";
import Keyholders from "../components/Keyholders.jsx";
import Notice from "../components/Notice.jsx";
import TaskChip from "../components/TaskChip.jsx";
import { ClockIcon, FileIcon } from "../components/Icons.jsx";
import { canSelectPaper, useChainNow, vaultWrite } from "../lib/chain.js";
import { fromHex, pieceCommitment, seedCommitment } from "../lib/crypto.js";
import { deployment } from "../lib/deployment.js";
import { fmtCountdown, fmtDuration, fmtEth, PAPER_NAMES, sameAddr } from "../lib/format.js";
import { useTx } from "../lib/useTx.js";
import { useWallet } from "../lib/wallet.jsx";

// ------------------------------------------------------------------ key file

/** Checks a staff key file: { version, staffIndex, staffAddress|null, pieces[3], seed }. */
function parseKeyFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON.");
  }
  if (!Array.isArray(j.pieces) || j.pieces.length !== 3) throw new Error("The key file needs 3 pieces (papers A, B, C).");
  j.pieces.forEach((p) => fromHex(p)); // throws on bad hex
  if (j.seed === undefined || j.seed === null) throw new Error("The key file has no secret number (seed).");
  const seed = BigInt(j.seed);
  return { staffIndex: Number(j.staffIndex), staffAddress: j.staffAddress ?? null, pieces: j.pieces, seed };
}

// Kept for this browser tab only, so a page reload does not lose the loaded file.
const storeKey = (address) => `examvault:keyfile:${deployment.vault}:${address}`.toLowerCase();
function loadStored(address) {
  try {
    const t = sessionStorage.getItem(storeKey(address));
    return t ? parseKeyFile(t) : null;
  } catch {
    return null;
  }
}
function saveStored(address, text) {
  try {
    if (text) sessionStorage.setItem(storeKey(address), text);
    else sessionStorage.removeItem(storeKey(address));
  } catch {
    /* storage blocked: fine, user re-loads the file */
  }
}

function KeyFileLoader({ address, keyFile, onLoad }) {
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [error, setError] = useState(null);

  const accept = (text) => {
    try {
      const k = parseKeyFile(text);
      saveStored(address, text);
      setError(null);
      setPaste("");
      setShowPaste(false);
      onLoad(k);
    } catch (e) {
      setError(e.message);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) accept(await f.text());
    e.target.value = "";
  };

  return (
    <div className="keyfile">
      <div className="keyfile-row">
        <span className="inline-icon">
          <FileIcon size={16} />
          {keyFile ? <>Key file loaded <span className="muted">(Staff {keyFile.staffIndex})</span></> : "No key file loaded"}
        </span>
        <span className="keyfile-actions">
          <label className="btn btn-ghost btn-sm">
            {keyFile ? "Replace" : "Load key file"}
            <input type="file" accept=".json,application/json" onChange={onFile} hidden />
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowPaste((s) => !s)}>Paste JSON</button>
          {keyFile && (
            <button className="btn btn-ghost btn-sm" onClick={() => { saveStored(address, null); onLoad(null); }}>
              Forget
            </button>
          )}
        </span>
      </div>
      {showPaste && (
        <div className="paste">
          <textarea className="mono" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)}
            placeholder='{ "version": 1, "staffIndex": 1, "pieces": ["0x…", "0x…", "0x…"], "seed": "…" }' />
          <button className="btn btn-ghost btn-sm" onClick={() => accept(paste)} disabled={!paste.trim()}>Use this key</button>
        </div>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ next step

/**
 * Decides the one primary action for this keyholder right now.
 * Returns { label, send?: (vault) => tx, disabled?, hint?, until? (unix time for a countdown) }.
 */
function nextStep(v, me, now, key) {
  const beforeExam = v.examTime === 0 || now < v.examTime;
  const needKey = (step) => (key ? step : { ...step, send: undefined, disabled: true, hint: "Load your key file first." });

  if (beforeExam) {
    if (me.stake < v.minStake) {
      const missing = v.minStake - me.stake;
      return {
        label: "Stake deposit",
        hint: `Lock ${fmtEth(missing)} as a promise that you will show up.`,
        send: (c) => c.stake({ value: missing }),
      };
    }
    if (v.examTime === 0) return { label: "Waiting for the exam to be set", disabled: true, hint: "The admin has not set the exam time yet." };
    if (!me.piecesCommitted) {
      return needKey({
        label: "Save my key",
        hint: "Saves a fingerprint of your 3 key pieces on-chain (the pieces stay secret).",
        send: (c) => c.commitPieces([0, 1, 2].map((p) => pieceCommitment(deployment.vault, me.address, p, key.pieces[p]))),
      });
    }
    if (!me.seedCommitted) {
      return needKey({
        label: "Save secret number",
        hint: "Saves a fingerprint of your secret number. It helps pick the paper later.",
        send: (c) => c.commitSeed(seedCommitment(deployment.vault, me.address, key.seed)),
      });
    }
    return { label: "Reveal secret number", disabled: true, until: v.examTime, hint: "All saved. Come back at exam time." };
  }

  if (v.postponed) {
    if (!me.withdrawn) return { label: "Withdraw deposit", send: (c) => c.withdrawStake() };
    return { label: "Deposit withdrawn", disabled: true, hint: "The exam was postponed." };
  }

  if (!v.paperSelected) {
    const seedOpen = now < v.examTime + v.seedWindow;
    if (me.seedCommitted && !me.seedRevealed && seedOpen) {
      return needKey({
        label: "Reveal secret number",
        hint: "Publishes your secret number. It must match what you saved.",
        send: (c) => c.revealSeed(key.seed),
      });
    }
    if (canSelectPaper(v, now)) {
      return { label: "Pick paper", hint: "Enough secret numbers are in. Anyone can ask the contract to pick now.", send: (c) => c.selectPaper() };
    }
    if (!v.dutiesOver) {
      return {
        label: "Pick paper",
        disabled: true,
        until: v.examTime + v.seedWindow,
        hint: `Waiting for keyholders to reveal their secret numbers (${v.seedsRevealed} of ${v.seedsCommitted}).`,
      };
    }
  } else {
    const revealOpen = now < v.selectedAt + v.revealWindow;
    if (me.piecesCommitted && !me.pieceRevealed && revealOpen) {
      return needKey({
        label: "Reveal my key",
        hint: `Publishes your piece for Paper ${PAPER_NAMES[v.selectedPaper]} only.`,
        send: (c) => c.revealPiece(key.pieces[v.selectedPaper]),
      });
    }
    if (!v.dutiesOver) {
      return {
        label: "Withdraw deposit",
        disabled: true,
        until: v.selectedAt + v.revealWindow,
        hint: "You can take your deposit back once the reveal window closes.",
      };
    }
  }

  // Duties over.
  if (me.withdrawn) return { label: "Deposit withdrawn", disabled: true, hint: "All done. Thank you!" };
  if (me.stake === 0n) return { label: "Nothing to withdraw", disabled: true };
  return {
    label: "Withdraw deposit",
    hint: me.missedDuty && !me.penalised ? "You missed a duty, so half of your deposit will be kept." : `Returns ${fmtEth(me.stake)}.`,
    send: (c) => c.withdrawStake(),
  };
}

// ------------------------------------------------------------------ screen

export default function Staff({ vault: v, refresh }) {
  const wallet = useWallet();
  const now = useChainNow();
  const tx = useTx(refresh);
  const me = v.staff.find((s) => sameAddr(s.address, wallet.address));
  const [keyFile, setKeyFile] = useState(null);

  useEffect(() => {
    setKeyFile(wallet.address ? loadStored(wallet.address) : null);
  }, [wallet.address]);

  // Compare the loaded key file with what this staff member committed on-chain.
  const keyCheck = useMemo(() => {
    if (!keyFile || !me) return null;
    const warnings = [];
    if (keyFile.staffAddress && !sameAddr(keyFile.staffAddress, me.address)) {
      warnings.push(`This key file belongs to ${keyFile.staffAddress}, not this wallet.`);
    } else if (keyFile.staffIndex && keyFile.staffIndex !== me.index) {
      warnings.push(`This key file is for Staff ${keyFile.staffIndex}, but this wallet is Staff ${me.index}.`);
    }
    let matches = null;
    if (me.piecesCommitted) {
      try {
        matches = [0, 1, 2].every(
          (p) => pieceCommitment(deployment.vault, me.address, p, keyFile.pieces[p]).toLowerCase() === me.pieceCommits[p].toLowerCase(),
        );
      } catch {
        matches = false;
      }
      if (!matches) warnings.push("These key pieces do not match what this wallet saved on-chain. Revealing them will fail.");
    }
    return { warnings, matches };
  }, [keyFile, me]);

  if (!wallet.address) {
    return (
      <div className="card empty-card">
        <h1 className="h1">Staff</h1>
        <p className="muted">Connect a wallet or pick a <b>Staff</b> demo account at the top to continue.</p>
      </div>
    );
  }

  const penaltyList = v.staff.filter((s) => s.missedDuty && !s.penalised && !s.withdrawn);
  const penaliseAll = async () => {
    const c = vaultWrite(wallet.signer);
    for (const s of penaltyList) {
      const ok = await tx.run(`Penalising Staff ${s.index}`, () => c.penalise(s.address));
      if (!ok) break;
    }
  };

  const penaltyCard = v.dutiesOver && (
    <div className="card side-card">
      <h3 className="card-title">No-shows</h3>
      {v.staff.some((s) => s.missedDuty) ? (
        <ul className="list">
          {v.staff.filter((s) => s.missedDuty).map((s) => (
            <li key={s.address}>
              <span>Staff {s.index}</span>
              <span className={s.penalised ? "amber-text small" : "muted small"}>
                {s.penalised ? "penalised" : s.withdrawn ? "withdrawn" : "missed a duty"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Everyone did their part.</p>
      )}
      <button className="btn btn-ghost" disabled={!penaltyList.length || !!tx.busy || !wallet.signer} onClick={penaliseAll}>
        Penalise no-shows{penaltyList.length ? ` (${penaltyList.length})` : ""}
      </button>
    </div>
  );

  if (!me) {
    return (
      <div className="staff-grid">
        <div className="card main-card">
          <h1 className="h1">This wallet is not a keyholder</h1>
          <p className="muted">Pick one of the <b>Staff 1–5</b> demo accounts (or switch MetaMask) to act as a keyholder.</p>
          {tx.error && <Notice tone="red">{tx.error}</Notice>}
        </div>
        <div className="side">
          <Keyholders staff={v.staff} me={null} piecesRevealed={v.piecesRevealed} />
          {penaltyCard}
        </div>
      </div>
    );
  }

  const step = nextStep(v, me, now, keyFile);
  const go = () => tx.run(step.label, () => step.send(vaultWrite(wallet.signer)));
  const revealEnds = v.paperSelected ? v.selectedAt + v.revealWindow : null;

  return (
    <div className="staff-grid">
      <div className="card main-card">
        <h1 className="h1">Hi, Staff {me.index}</h1>
        <p className="muted">You hold 1 of 5 keys. Any 3 keys open the paper.</p>

        <div className="tasks">
          <TaskChip done={me.stake >= v.minStake || me.withdrawn}>Deposit locked</TaskChip>
          <TaskChip done={me.piecesCommitted}>Key saved</TaskChip>
          <TaskChip done={me.seedCommitted}>Secret number saved</TaskChip>
          <TaskChip done={me.seedRevealed}>Secret number revealed</TaskChip>
          <TaskChip done={me.pieceRevealed}>Key revealed</TaskChip>
        </div>

        <KeyFileLoader address={wallet.address} keyFile={keyFile} onLoad={setKeyFile} />
        {keyCheck?.matches && <Notice tone="mint">Key file matches your on-chain fingerprints.</Notice>}
        {keyCheck?.warnings.map((w) => <Notice key={w} tone="red">{w}</Notice>)}

        <div className="action">
          <button className="btn btn-primary btn-lg" onClick={go}
            disabled={step.disabled || !step.send || !!tx.busy || !wallet.signer}>
            {tx.busy ? `${tx.busy}…` : step.label}
          </button>
          {step.until && (
            <span className="opens-in">
              <ClockIcon size={16} /> Opens in <span className="mono">{fmtCountdown(step.until - now)}</span>
            </span>
          )}
        </div>
        {step.hint && <p className="muted small">{step.hint}</p>}
        {tx.error && <Notice tone="red">{tx.error}</Notice>}
        {tx.lastOk && !tx.error && <Notice tone="mint">{tx.lastOk}: done.</Notice>}

        <Notice tone="amber">
          You get {fmtDuration(v.revealWindow)} after the paper is picked. Miss it and part of your deposit is lost.
          {revealEnds && now < revealEnds && (
            <> Window closes in <b className="mono">{fmtCountdown(revealEnds - now)}</b>.</>
          )}
          {revealEnds && now >= revealEnds && <> The reveal window has closed.</>}
        </Notice>

        <div className="meta-row muted small">
          <span>Deposit <span className="mono">{fmtEth(me.stake)}</span></span>
          <span>Minimum <span className="mono">{fmtEth(v.minStake)}</span></span>
          {me.penalised && <span className="amber-text">Penalised</span>}
          {me.withdrawn && <span className="mint-text">Withdrawn</span>}
          {v.paperSelected && <span>Picked: Paper {PAPER_NAMES[v.selectedPaper]}</span>}
        </div>
      </div>

      <div className="side">
        <Keyholders staff={v.staff} me={me.address} piecesRevealed={v.piecesRevealed} />
        {penaltyCard}
      </div>
    </div>
  );
}
