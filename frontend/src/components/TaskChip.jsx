import { CheckIcon } from "./Icons.jsx";

/** A to-do chip with a check circle that fills mint when done. */
export default function TaskChip({ done, children }) {
  return (
    <span className={`task ${done ? "task-done" : ""}`}>
      <span className="task-check">{done && <CheckIcon size={12} />}</span>
      {children}
    </span>
  );
}
