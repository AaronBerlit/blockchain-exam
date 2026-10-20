import { PadlockIcon } from "./Icons.jsx";
import { PAPER_NAMES } from "../lib/format.js";

/** "In the vault": Paper A/B/C. After selection the chosen one is mint, the others dim. */
export default function PaperChips({ selected = null, unlocked = false }) {
  return (
    <div className="chips">
      {PAPER_NAMES.map((name, i) => {
        const cls = selected === null ? "" : selected === i ? "chip-chosen" : "chip-dim";
        return (
          <span key={name} className={`chip ${cls}`}>
            <PadlockIcon size={15} open={unlocked && selected === i} />
            Paper {name}
          </span>
        );
      })}
    </div>
  );
}
