import { useEffect, useState } from "react";
import Notice from "../components/Notice.jsx";
import StatusPill from "../components/StatusPill.jsx";
import { CheckIcon } from "../components/Icons.jsx";
import { examPhase, friendlyError, useChainNow, vaultRead, vaultWrite } from "../lib/chain.js";
import { combineKey, decryptPaper, fromHex, paperHash } from "../lib/crypto.js";
import { ipfsGateway } from "../lib/deployment.js";
import { fmtLocalTime, PAPER_NAMES, sameAddr, shortAddr, tokenNo } from "../lib/format.js";
import { useTx } from "../lib/useTx.js";
import { useWallet } from "../lib/wallet.jsx";

const STAGES = [
  { id: "fetch", label: "Fetch file" },
  { id: "key", label: "Rebuild key" },
  { id: "decrypt", label: "Decrypt" },
];

export default function College({ vault: v, refresh }) {
  const wallet = useWallet();
  const now = useChainNow();
  const tx = useTx(refresh);
  const [stage, setStage] = useState(0); // number of stages completed
  const [running, setRunning] = useState(false);
  const [hashOk, setHashOk] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { fileName, text, url }

  const college = v.colleges.find((c) => sameAddr(c.address, wallet.address));
  const hasToken = !!college && college.tokenId > 0 && college.holdsToken;
  const phase = examPhase(v, now);
  const canDownload = v.unlocked && hasToken && !!wallet.signer && !running;

  // Free the Blob URL when the result changes or the screen closes.
  useEffect(() => () => result && URL.revokeObjectURL(result.url), [result]);

  const download = async () => {
    setRunning(true);
    setError(null);
    setHashOk(null);
    setStage(0);
    setResult(null);
    try {
      // 1. Record the download on-chain (fails unless unlocked + token held).
      const receipt = await tx.run("Logging your download", () => vaultWrite(wallet.signer).logDownload());
      if (!receipt) return;

      // 2. Fetch the encrypted file and check it is the one locked in the contract.
      const paper = v.selectedPaper;
      const res = await fetch(`${ipfsGateway}/${v.papers.cids[paper]}`);
      if (!res.ok) throw new Error(`Could not fetch the encrypted file (HTTP ${res.status}).`);
      const enc = new Uint8Array(await res.arrayBuffer());
      const ok = paperHash(enc).toLowerCase() === v.papers.hashes[paper].toLowerCase();
      setHashOk(ok);
      if (!ok) throw new Error("Hash mismatch: this file is not the one locked in the contract. Stopped.");
      setStage(1);

      // 3. Rebuild the AES key from the revealed Shamir pieces.
      const { pieces } = await vaultRead.getRevealedPieces();
      const key = await combineKey([...pieces].map((p) => fromHex(p)));
      setStage(2);

      // 4. Decrypt.
      const { fileName, bytes } = await decryptPaper(enc, key);
      const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain;charset=utf-8" }));
      setResult({ fileName: fileName || `paper-${PAPER_NAMES[paper]}.txt`, text: new TextDecoder().decode(bytes), url });
      setStage(3);
    } catch (e) {
      setError(e instanceof Error && !e.code ? e.message : friendlyError(e));
    } finally {
      setRunning(false);
    }
  };

  const nameOf = (addr) => v.colleges.find((c) => sameAddr(c.address, addr))?.name || shortAddr(addr);

  return (
    <div className="stack">
      <section className="card college-card">
        <StatusPill phase={v.unlocked ? "UNLOCKED" : phase === "POSTPONED" ? "POSTPONED" : "LOCKED"} />
        <p className="muted picked-label">The contract picked</p>
        <div className={`paper-name ${v.paperSelected ? "" : "muted"}`}>
          {v.paperSelected ? `Paper ${PAPER_NAMES[v.selectedPaper]}` : "Not yet"}
        </div>

        <button className="btn btn-primary btn-lg" disabled={!canDownload} onClick={download}>
          {running ? (tx.busy ? `${tx.busy}…` : "Working…") : "Download and decrypt"}
        </button>

        <div className="progress-chips">
          {STAGES.map((s, i) => (
            <span key={s.id} className={`task ${stage > i ? "task-done" : running && stage === i ? "task-active" : ""}`}>
              <span className="task-check">{stage > i && <CheckIcon size={12} />}</span>
              {s.label}
            </span>
          ))}
        </div>

        {hashOk && (
          <p className="mint-text inline-icon small"><CheckIcon size={14} /> Hash verified</p>
        )}
        {error && <Notice tone="red">{error}</Notice>}
        {!error && tx.error && <Notice tone="red">{tx.error}</Notice>}

        <div className="token-row">
          {hasToken ? (
            <>
              <span className="dot" />
              <span>Access token held · {college.name} · <span className="mono">{tokenNo(college.tokenId)}</span></span>
            </>
          ) : (
            <>
              <span className="dot dot-grey" />
              <span className="muted">
                {wallet.address ? "No access token on this wallet — download disabled." : "Connect a wallet or pick a college demo account."}
              </span>
            </>
          )}
        </div>
        <p className="muted small footnote">No token on this wallet? The button stays off.</p>
      </section>

      {result && (
        <section className="card">
          <div className="result-head">
            <h2 className="card-title">{result.fileName}</h2>
            <a className="btn btn-ghost btn-sm" href={result.url} download={result.fileName}>Save file</a>
          </div>
          <pre className="preview">{result.text}</pre>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Download log</h2>
        {v.downloads.length === 0 ? (
          <p className="muted small">No downloads yet.</p>
        ) : (
          <ul className="list">
            {v.downloads.map((d, i) => (
              <li key={i}>
                <span>{nameOf(d.college)} <span className="mono muted">{tokenNo(d.tokenId)}</span></span>
                <span className="mono muted small">{fmtLocalTime(d.time)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
