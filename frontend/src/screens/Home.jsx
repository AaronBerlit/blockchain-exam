import PaperChips from "../components/PaperChips.jsx";
import StatusPill from "../components/StatusPill.jsx";
import StepTracker from "../components/StepTracker.jsx";
import VaultDial from "../components/VaultDial.jsx";
import { examPhase, useChainNow } from "../lib/chain.js";
import { deployment } from "../lib/deployment.js";
import { fmtCountdown, fmtLocalTime } from "../lib/format.js";

/** What the big countdown shows in each phase. */
function countdownFor(v, phase, now) {
  switch (phase) {
    case "LOCKED":
      return { secs: v.examTime - now, caption: <>until the paper opens at <b>{fmtLocalTime(v.examTime)}</b></> };
    case "PICKING":
      return {
        secs: v.examTime + v.seedWindow - now,
        caption: "left for keyholders to reveal their secret numbers, then the contract picks a paper",
      };
    case "REVEALING":
      return {
        secs: v.selectedAt + v.revealWindow - now,
        caption: "left for keyholders to reveal their keys",
      };
    case "UNLOCKED":
      return { secs: 0, caption: "The paper is open. Colleges with an access token can download it." };
    case "POSTPONED":
      return { secs: 0, caption: "Not enough keyholders turned up in time, so the exam was postponed." };
    default:
      return { secs: 0, caption: "The admin has not set the exam time yet." };
  }
}

/** Ring fill: share of the wait from deployment to exam time; full after that. */
function dialProgress(v, now) {
  if (v.examTime === 0) return 0;
  if (now >= v.examTime) return 1;
  const start = v.startTime && v.startTime < v.examTime ? v.startTime : v.examTime - 3600;
  return (now - start) / (v.examTime - start);
}

export default function Home({ vault: v }) {
  const now = useChainNow();
  const phase = examPhase(v, now);
  const { secs, caption } = countdownFor(v, phase, now);
  const activeStep = { "NOT SET": 0, LOCKED: 0, PICKING: 1, REVEALING: 2, UNLOCKED: 3, POSTPONED: v.paperSelected ? 2 : 1 }[phase];

  return (
    <div className="stack">
      <section className="hero">
        <div className="hero-dial">
          <VaultDial progress={dialProgress(v, now)} unlocked={v.unlocked} muted={phase === "POSTPONED"} />
        </div>
        <div className="hero-text">
          <StatusPill phase={phase} />
          <h1 className="exam-title">{deployment.examTitle || "Final exam paper"}</h1>
          <div className={`countdown mono ${v.unlocked ? "mint-text" : ""}`} aria-live="off">{fmtCountdown(secs)}</div>
          <p className="muted caption">{caption}</p>
          <p className="tagline">Nobody can open it early, not even the admin.</p>
        </div>
      </section>

      <StepTracker active={activeStep} />

      <section className="card vault-card">
        <div className="vault-row">
          <div>
            <h2 className="card-title">In the vault</h2>
            <PaperChips selected={v.paperSelected ? v.selectedPaper : null} unlocked={v.unlocked} />
          </div>
          <div className="counts">
            <div className="count">
              <span className="mono big-num">{Math.min(v.piecesRevealed, 3)}</span>
              <span className="muted small">of 3 keys revealed</span>
            </div>
            <div className="count">
              <span className="mono big-num">{v.seedsRevealed}</span>
              <span className="muted small">of {v.seedsCommitted || 5} secret numbers revealed</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
