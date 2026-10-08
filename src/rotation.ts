/**
 * Rotation patterns: a member's base schedule is a repeating cycle of
 * shift codes anchored to a start date. Approved swaps are layered on
 * top as per-date overrides.
 *
 * Patterns are the standard published 12-hour rotations. Each cycle
 * string has one character per day: D = day shift, N = night shift,
 * - = off.
 */
import { addDays, daysBetween, zonedTimeToUtc, HOUR } from "./time";

export type ShiftCode = "D" | "N" | "-";
export type WorkShift = Exclude<ShiftCode, "-">;

export const SHIFT_DEFS: Record<
  WorkShift,
  { label: string; start: string; hours: number }
> = {
  D: { label: "Day (7a-7p)", start: "07:00", hours: 12 },
  N: { label: "Night (7p-7a)", start: "19:00", hours: 12 }
};

export const PATTERNS = {
  pitman: {
    name: "Pitman 2-2-3 (days)",
    cycle: "DD--DDD--DD---"
  },
  pitmanNights: {
    name: "Pitman 2-2-3 (nights)",
    cycle: "NN--NNN--NN---"
  },
  panama: {
    name: "Panama 2-2-3 (rotating days/nights)",
    cycle: "DD--DDD--DD---NN--NNN--NN---"
  },
  dupont: {
    name: "DuPont (4N 3off 3D 1off 3N 3off 4D 7off)",
    cycle: "NNNN---DDD-NNN---DDDD-------"
  },
  fourOnFourOff: {
    name: "4 on / 4 off (days)",
    cycle: "DDDD----"
  },
  fourOnFourOffNights: {
    name: "4 on / 4 off (nights)",
    cycle: "NNNN----"
  }
} as const satisfies Record<string, { name: string; cycle: string }>;

export type PatternKey = keyof typeof PATTERNS;

export function isPatternKey(key: string): key is PatternKey {
  return Object.hasOwn(PATTERNS, key);
}

/** The shift a pattern assigns on `date`, given the cycle's day-0 anchor. */
export function patternShift(
  pattern: PatternKey,
  anchorDate: string,
  date: string
): ShiftCode {
  const cycle = PATTERNS[pattern].cycle;
  const n = daysBetween(anchorDate, date);
  const i = ((n % cycle.length) + cycle.length) % cycle.length;
  return cycle[i] as ShiftCode;
}

/** UTC [start, end) of a shift that starts on local `date`. */
export function shiftInterval(
  date: string,
  shift: WorkShift,
  timeZone: string
): [number, number] {
  const def = SHIFT_DEFS[shift];
  const start = zonedTimeToUtc(date, def.start, timeZone);
  // Compute the end from the local wall clock too, so a night shift that
  // crosses a DST change still ends at 07:00 local.
  const endH = Number(def.start.slice(0, 2)) + def.hours;
  const endDate = addDays(date, Math.floor(endH / 24));
  const endTime = `${String(endH % 24).padStart(2, "0")}${def.start.slice(2)}`;
  const end = zonedTimeToUtc(endDate, endTime, timeZone);
  return [start, end > start ? end : start + def.hours * HOUR];
}
