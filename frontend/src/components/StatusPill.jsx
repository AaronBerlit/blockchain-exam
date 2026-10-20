import { PadlockIcon } from "./Icons.jsx";

const TONE = {
  "NOT SET": "muted",
  LOCKED: "amber",
  PICKING: "amber",
  REVEALING: "amber",
  UNLOCKED: "mint",
  POSTPONED: "muted",
};

/** Rounded status pill: LOCKED (amber) ... UNLOCKED (mint). */
export default function StatusPill({ phase }) {
  const tone = TONE[phase] ?? "muted";
  return (
    <span className={`pill pill-${tone}`}>
      <PadlockIcon size={14} open={phase === "UNLOCKED"} strokeWidth={2.4} />
      {phase}
    </span>
  );
}
