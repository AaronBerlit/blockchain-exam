import { PadlockIcon } from "./Icons.jsx";

const SIZE = 320;
const C = SIZE / 2;
const R_PROGRESS = 122;
const CIRC = 2 * Math.PI * R_PROGRESS;

/**
 * The round "vault door" on the Home screen.
 * progress: 0..1 of the ring to fill. unlocked: ring + padlock turn mint, padlock opens.
 */
export default function VaultDial({ progress = 0, unlocked = false, muted = false }) {
  const p = Math.min(1, Math.max(0, progress));
  const color = muted ? "var(--muted)" : unlocked ? "var(--mint)" : "var(--amber)";
  const ticks = Array.from({ length: 60 }, (_, i) => i);

  return (
    <svg className="dial" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img"
      aria-label={unlocked ? "Vault unlocked" : `Vault locked, ${Math.round(p * 100)}% of the wait done`}>
      <circle cx={C} cy={C} r={156} fill="var(--surface)" stroke="var(--border)" strokeWidth="1.5" />
      <circle cx={C} cy={C} r={140} fill="none" stroke="var(--ring)" strokeWidth="2" strokeDasharray="3 9" />
      {ticks.map((i) => {
        const a = (i / 60) * 2 * Math.PI;
        const long = i % 5 === 0;
        const r1 = 147;
        const r2 = long ? 153 : 150;
        return (
          <line key={i} x1={C + r1 * Math.sin(a)} y1={C - r1 * Math.cos(a)} x2={C + r2 * Math.sin(a)}
            y2={C - r2 * Math.cos(a)} stroke="var(--ring)" strokeWidth={long ? 2 : 1} />
        );
      })}
      <circle cx={C} cy={C} r={R_PROGRESS} fill="none" stroke="var(--surface-2)" strokeWidth="10" />
      <circle cx={C} cy={C} r={R_PROGRESS} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - p)} transform={`rotate(-90 ${C} ${C})`}
        style={{ transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
      <circle cx={C} cy={C} r={100} fill="var(--surface-2)" stroke="var(--border)" strokeWidth="1.5" />
      <g transform={`translate(${C - 48} ${C - 48})`}>
        <PadlockIcon size={96} open={unlocked} color={color} strokeWidth={1.6} />
      </g>
    </svg>
  );
}
