import { sameAddr } from "../lib/format.js";
import { CheckIcon } from "./Icons.jsx";

/** 5 numbered circles. You = mint ring, revealed = filled mint, others grey. */
export default function Keyholders({ staff, me, piecesRevealed }) {
  return (
    <div className="card side-card">
      <h3 className="card-title">Keyholders</h3>
      <div className="holders">
        {staff.map((s) => {
          const cls = [
            "holder",
            s.pieceRevealed ? "holder-revealed" : "",
            sameAddr(s.address, me) ? "holder-me" : "",
          ].join(" ");
          return (
            <div key={s.address} className="holder-wrap" title={`Staff ${s.index}${s.pieceRevealed ? " · key revealed" : ""}`}>
              <span className={cls}>{s.index}</span>
              <span className="holder-label">{sameAddr(s.address, me) ? "You" : s.pieceRevealed ? "Revealed" : " "}</span>
            </div>
          );
        })}
      </div>
      <div className="holders-count">
        <span className="mono big-num">{Math.min(piecesRevealed, 3)}</span>
        <span className="muted"> of 3 revealed</span>
        {piecesRevealed >= 3 && (
          <span className="mint-text inline-icon"><CheckIcon size={14} /> enough to open</span>
        )}
      </div>
    </div>
  );
}
