/**
 * Pure, deterministic availability math. No I/O, no Date.now() calls:
 * everything time-dependent is passed in so it can be unit tested.
 *
 * The LLM never computes free time itself. It calls the findSlots tool,
 * which calls into this module.
 */

export type BusyInterval = {
  /** ISO 8601 instant (UTC) */
  start: string;
  /** ISO 8601 instant (UTC) */
  end: string;
};

export type TimeOfDay = "morning" | "afternoon" | "any";

export type SlotPrefs = {
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
  /** Local wall-clock "HH:MM" */
  workStart: string;
  /** Local wall-clock "HH:MM" */
  workEnd: string;
  /** Minutes of free time required before and after each meeting */
  bufferMin: number;
  /** Days of week that count as working days (0 = Sunday). Defaults to Mon-Fri. */
  workDays?: number[];
};

export type FindSlotsInput = {
  durationMin: number;
  /** First local date to search, "YYYY-MM-DD" in prefs.timezone */
  startDate: string;
  /** Last local date to search (inclusive), "YYYY-MM-DD" in prefs.timezone */
  endDate: string;
  timeOfDay?: TimeOfDay;
  events: BusyInterval[];
  prefs: SlotPrefs;
  /** Slots that start before this instant are never returned */
  now: Date;
  /** Max slots to return (default 3) */
  max?: number;
  /** Candidate start granularity in minutes (default 30) */
  stepMin?: number;
};

export type Slot = {
  start: string;
  end: string;
  /** Human readable, in the user's timezone */
  label: string;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOON = "12:00";
const MAX_RANGE_DAYS = 31;

// ── Timezone helpers ──────────────────────────────────────────────────

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

type LocalParts = {
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
  // Try both offsets around the naive instant and keep the ones that map back.
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

export function formatSlotLabel(
  startMs: number,
  endMs: number,
  timeZone: string
): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(startMs));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  });
  return `${day}, ${time.format(new Date(startMs))} - ${time.format(new Date(endMs))}`;
}

// ── Core ──────────────────────────────────────────────────────────────

/**
 * True when [start, end) plus `bufferMin` on each side does not overlap
 * any busy interval. Used both by findSlots and by the booking workflow's
 * re-check just before the event is written.
 */
export function isFree(
  startMs: number,
  endMs: number,
  events: BusyInterval[],
  bufferMin: number,
  ignoreId?: string
): boolean {
  const lo = startMs - bufferMin * MINUTE;
  const hi = endMs + bufferMin * MINUTE;
  return events.every((e) => {
    if (ignoreId && (e as { id?: string }).id === ignoreId) return true;
    const s = Date.parse(e.start);
    const t = Date.parse(e.end);
    return t <= lo || s >= hi;
  });
}

export function findSlots(input: FindSlotsInput): Slot[] {
  const {
    durationMin,
    startDate,
    endDate,
    timeOfDay = "any",
    events,
    prefs,
    now,
    max = 3,
    stepMin = 30
  } = input;

  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new Error("durationMin must be a positive number");
  }
  if (max <= 0) return [];
  assertTimezone(prefs.timezone);
  const workDays = prefs.workDays ?? [1, 2, 3, 4, 5];
  const durMs = durationMin * MINUTE;
  const stepMs = stepMin * MINUTE;
  const nowMs = now.getTime();

  const days = enumerateDates(startDate, endDate);
  const perDay: Slot[][] = [];

  for (const date of days) {
    const [y, m, d] = parseDate(date);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!workDays.includes(weekday)) continue;

    let winStart = prefs.workStart;
    let winEnd = prefs.workEnd;
    if (timeOfDay === "morning") winEnd = minTime(winEnd, NOON);
    if (timeOfDay === "afternoon") winStart = maxTime(winStart, NOON);
    if (parseMinutes(winStart) >= parseMinutes(winEnd)) continue;

    const startMs = zonedTimeToUtc(date, winStart, prefs.timezone);
    const endMs = zonedTimeToUtc(date, winEnd, prefs.timezone);

    const found: Slot[] = [];
    for (let t = startMs; t + durMs <= endMs; t += stepMs) {
      if (t < nowMs) continue;
      if (!isFree(t, t + durMs, events, prefs.bufferMin)) continue;
      found.push({
        start: new Date(t).toISOString(),
        end: new Date(t + durMs).toISOString(),
        label: formatSlotLabel(t, t + durMs, prefs.timezone)
      });
    }
    if (found.length > 0) perDay.push(found);
  }

  // Round-robin across days so a request like "Tue or Wed" gets options
  // on both days instead of three back-to-back slots on Tuesday.
  const out: Slot[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const daySlots of perDay) {
      if (round < daySlots.length && out.length < max) {
        out.push(daySlots[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ── Parsing ───────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`Invalid time "${time}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Invalid time "${time}"`);
  return [h, min];
}

function parseMinutes(time: string): number {
  const [h, m] = parseTime(time);
  return h * 60 + m;
}

function minTime(a: string, b: string): string {
  return parseMinutes(a) <= parseMinutes(b) ? a : b;
}

function maxTime(a: string, b: string): string {
  return parseMinutes(a) >= parseMinutes(b) ? a : b;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const [y1, m1, d1] = parseDate(startDate);
  const [y2, m2, d2] = parseDate(endDate);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  if (b < a) throw new Error("endDate is before startDate");
  if ((b - a) / DAY > MAX_RANGE_DAYS) {
    throw new Error(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  }
  const out: string[] = [];
  for (let t = a; t <= b; t += DAY) {
    const d = new Date(t);
    out.push(
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    );
  }
  return out;
}
