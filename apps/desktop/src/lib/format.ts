import { daysBetween, shortDate, today } from "./dates";

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const m = Math.round(ms / 6e4);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 100) return `${h}h`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

export function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(ms);
  return shortDate(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
}

/** Time until a usage reset: compact "42m", "4h10", "1d21h"; spaced "4h 10m", "1d 21h". */
export function fmtUntil(iso: string | null, spaced = false): string {
  if (!iso) return "–";
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 6e4));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const sp = spaced ? " " : "";
  if (h < 24) return spaced ? (m % 60 ? `${h}h${sp}${m % 60}m` : `${h}h`) : `${h}h${String(m % 60).padStart(2, "0")}`;
  return spaced && h % 24 === 0 ? `${h / 24}d` : `${Math.floor(h / 24)}d${sp}${h % 24}h`;
}

export type DeadlineTone = "overdue" | "soon" | "later";

export function deadlineInfo(day: string): { label: string; tone: DeadlineTone; days: number } {
  const days = daysBetween(today(), day);
  const tone: DeadlineTone = days < 0 ? "overdue" : days <= 3 ? "soon" : "later";
  const label =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : days < 0 ? `${-days}d overdue` : shortDate(day);
  return { label, tone, days };
}

/** Markdown as one plain line: drops emphasis, code ticks, heading/list marks and link targets. */
export const plainText = (md: string) =>
  md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#+|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const parentPath = (p: string) => shortPath(p.split("/").slice(0, -1).join("/"));
/** Last n folders of the parent path, e.g. "code/scratch". */
export const parentTail = (p: string, n = 2) => {
  const parts = shortPath(p).split("/").slice(0, -1);
  return (parts.length > n ? "…/" : "") + parts.slice(-n).join("/");
};
