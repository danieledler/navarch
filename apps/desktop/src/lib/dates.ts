// Local-calendar helpers. Days are "YYYY-MM-DD" strings in local time; weeks are ISO weeks "2026-W44".

const pad = (n: number) => String(n).padStart(2, "0");

export const dayStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => dayStr(new Date());

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return dayStr(d);
}

export const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 864e5);

/** Monday of the week containing day s. */
export function weekStart(s: string): string {
  const d = parseDay(s);
  return addDays(s, -((d.getDay() + 6) % 7));
}

export function isoWeek(s: string): string {
  const d = parseDay(s);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); // Thursday of this week
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

export const weekNumber = (week: string) => Number(week.split("W")[1]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (s: string) => {
  const d = parseDay(s);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export const weekLabel = (start: string) => `${shortDate(start)} – ${shortDate(addDays(start, 6))}`;
