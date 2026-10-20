import { AlertIcon, CheckIcon } from "./Icons.jsx";

/** Small coloured message box. tone: amber | mint | red | muted */
export default function Notice({ tone = "amber", children }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "red" ? "alert" : undefined}>
      <span className="notice-icon">{tone === "mint" ? <CheckIcon size={16} /> : <AlertIcon size={16} />}</span>
      <div>{children}</div>
    </div>
  );
}
