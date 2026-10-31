// Pacing for Claude plan-limit windows: how much of the allowance is used vs. how much of the window has passed.
import type { Usage, UsageWindow } from "../api";

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 24 * 3600_000;

export type PaceTone = "good" | "warn" | "hot";

export interface Pace {
  percent: number; // used, 0–100
  expected: number | null; // share of the window elapsed, 0–100 (null when the reset time is unknown)
  delta: number | null; // percent − expected in whole points; negative = under an even pace
  tone: PaceTone;
}

export function paceOf(w: UsageWindow, windowMs: number, now = Date.now()): Pace {
  const percent = Math.max(0, Math.min(100, w.percent));
  let expected: number | null = null;
  if (w.resetsAt) {
    const left = new Date(w.resetsAt).getTime() - now;
    expected = Math.max(0, Math.min(100, (100 * (windowMs - left)) / windowMs));
  }
  // Rounded to whole points, the precision shown in the UI, so "0%" never reads as over pace.
  const delta = expected == null ? null : Math.round(percent - expected);
  const tone: PaceTone =
    percent >= 90 || (delta != null && delta > 15) ? "hot" : (delta != null && delta > 0) || (delta == null && percent >= 60) ? "warn" : "good";
  return { percent, expected, delta, tone };
}

export function usagePaces(u: Usage | null, now = Date.now()) {
  return {
    fiveHour: u?.fiveHour ? paceOf(u.fiveHour, FIVE_HOURS, now) : null,
    sevenDay: u?.sevenDay ? paceOf(u.sevenDay, SEVEN_DAYS, now) : null,
  };
}
