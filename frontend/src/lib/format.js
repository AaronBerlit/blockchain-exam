import { formatEther } from "ethers";

export const PAPER_NAMES = ["A", "B", "C"];

/** 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 -> 0x7099…79C8 */
export function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function sameAddr(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Seconds -> "HH:MM:SS" (hours can go past 24). Negative counts as zero. */
export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Unix seconds -> local date/time, e.g. "Tue 20 Oct, 14:30". */
export function fmtLocalTime(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Seconds -> "10 minutes" / "45 seconds" / "2 hours". */
export function fmtDuration(seconds) {
  const s = Number(seconds);
  if (s >= 3600 && s % 3600 === 0) return plural(s / 3600, "hour");
  if (s >= 60) return plural(Math.round(s / 60), "minute");
  return plural(s, "second");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** wei (bigint) -> "1.0 ETH" */
export function fmtEth(wei) {
  return `${formatEther(wei ?? 0n)} ETH`;
}

/** 1 -> "#0001" */
export function tokenNo(id) {
  return `#${String(id).padStart(4, "0")}`;
}
