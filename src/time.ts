/**
 * Timezone-aware calendar helpers. Pure: no Date.now() and no I/O, so
 * everything is unit testable. Built on Intl only (no date library).
 *
 * Dates are local calendar dates ("YYYY-MM-DD") in the team's zone.
 * Instants are UTC epoch milliseconds.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Throws a RangeError for an unknown IANA zone. */
export function assertTimezone(timeZone: string): void {
  partsFormatter(timeZone);
}

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** Wall-clock parts of a UTC instant in the given zone. */
export function toLocalParts(utcMs: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute
  };
}

/** Offset of the zone from UTC at the given instant, in ms (NY winter = -5h). */
function offsetAt(utcMs: number, timeZone: string): number {
  const p = toLocalParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(utcMs / MINUTE) * MINUTE;
}

/**
 * Convert a local wall-clock time in `timeZone` to a UTC instant.
 * Non-existent times (inside a spring-forward gap) resolve to the
 * instant just after the gap; ambiguous times (fall-back) resolve to
 * the earlier of the two instants.
 */
export function zonedTimeToUtc(
  date: string,
  time: string,
  timeZone: string
): number {
  const [y, m, d] = parseDate(date);
  const [hh, mm] = parseTime(time);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = new Set([
    naive - offsetAt(naive - DAY / 2, timeZone),
    naive - offsetAt(naive + DAY / 2, timeZone),
    naive - offsetAt(naive, timeZone)
  ]);
  const exact = [...candidates]
    .filter((utc) => {
      const p = toLocalParts(utc, timeZone);
      return (
        p.year === y &&
        p.month === m &&
        p.day === d &&
        p.hour === hh &&
        p.minute === mm
      );
    })
    .sort((a, b) => a - b);
  if (exact.length > 0) return exact[0];
  // In a DST gap: use the pre-transition offset, which lands after the gap.
  return naive - offsetAt(naive - DAY / 2, timeZone);
}

/** "YYYY-MM-DD" for the local date of an instant in the zone. */
export function localDate(utcMs: number, timeZone: string): string {
  const p = toLocalParts(utcMs, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Calendar arithmetic on local dates (DST-proof: never touches instants). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = parseDate(a);
  const [y2, m2, d2] = parseDate(b);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY
  );
}

/** 0 = Sunday */
export function weekday(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

/** "Fri, Oct 16" */
export function formatDate(date: string): string {
  const [, m, d] = parseDate(date);
  return `${WEEKDAY_SHORT[weekday(date)]}, ${MONTH_SHORT[m - 1]} ${d}`;
}

export function isDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return addDays(date, 0) === date;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`Invalid time "${time}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Invalid time "${time}"`);
  return [h, min];
}

const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
];

/**
 * Turn what a model or person might pass as a date into YYYY-MM-DD:
 * an ISO date, "today", "tomorrow", or a weekday name with an optional
 * "this/next/upcoming" ("friday" = the next Friday after today).
 * Returns null when it can't tell.
 */
export function resolveDate(input: string, today: string): string | null {
  const raw = input.trim().toLowerCase();
  const iso = /\d{4}-\d{2}-\d{2}/.exec(raw)?.[0];
  if (iso) return isDate(iso) ? iso : null;
  if (raw === "today") return today;
  if (raw === "tomorrow") return addDays(today, 1);
  const words = raw
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const day = words.find((w) =>
    WEEKDAY_NAMES.some((n) => n.startsWith(w) && w.length >= 3)
  );
  if (!day) return null;
  const target = WEEKDAY_NAMES.findIndex((n) => n.startsWith(day));
  const ahead = (target - weekday(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}
