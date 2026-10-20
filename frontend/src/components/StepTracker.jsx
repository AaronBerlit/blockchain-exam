import { CheckIcon } from "./Icons.jsx";

const STEPS = [
  { title: "Locked", text: "Waiting for exam time" },
  { title: "Pick a paper", text: "The contract picks A, B or C" },
  { title: "Open", text: "3 keyholders unlock it" },
];

/** 3 cards. `active` = index of the current step (0..2), or 3 when all are done. */
export default function StepTracker({ active }) {
  return (
    <div className="steps">
      {STEPS.map((s, i) => {
        const state = i < active ? "done" : i === active ? "active" : "todo";
        return (
          <div key={s.title} className={`card step step-${state}`}>
            <div className="step-top">
              <span className="eyebrow">STEP {i + 1}</span>
              {state === "done" && (
                <span className="step-check"><CheckIcon size={14} /></span>
              )}
            </div>
            <div className="step-title">{s.title}</div>
            <div className="muted small">{s.text}</div>
          </div>
        );
      })}
    </div>
  );
}
