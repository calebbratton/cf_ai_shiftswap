/**
 * Pure swap eligibility and ranking. The LLM decides *what* to do; this
 * module decides *who can* cover a shift. No I/O, fully unit tested.
 */
import {
  PATTERNS,
  SHIFT_DEFS,
  patternShift,
  shiftInterval,
  type PatternKey,
  type ShiftCode,
  type WorkShift
} from "./rotation";
import { addDays, formatDate, weekStart, HOUR } from "./time";

export type Member = {
  id: string;
  name: string;
  role: string;
  pattern: PatternKey;
  /** Local date that is day 0 of the member's cycle */
  anchorDate: string;
};

/** A per-date change to a member's pattern, written when a swap is approved. */
export type Override = {
  memberId: string;
  date: string;
  shift: ShiftCode;
};

/** "I'd pick up these shift types on this date." */
export type Flex = {
  memberId: string;
  date: string;
  shifts: WorkShift[];
};

export type TeamRules = {
  timezone: string;
  /** Minimum hours off between the end of one shift and the start of the next */
  minRestHours: number;
  maxShiftsPerWeek: number;
};

export type Roster = {
  members: Member[];
  overrides: Override[];
  flex: Flex[];
  rules: TeamRules;
};

export const DEFAULT_RULES: Omit<TeamRules, "timezone"> = {
  minRestHours: 10,
  maxShiftsPerWeek: 4
};

export function findMember(roster: Roster, id: string): Member | undefined {
  return roster.members.find((m) => m.id === id);
}

/** Effective shift: the latest override for that date, else the pattern. */
export function shiftOn(
  roster: Roster,
  memberId: string,
  date: string
): ShiftCode {
  for (let i = roster.overrides.length - 1; i >= 0; i--) {
    const o = roster.overrides[i];
    if (o.memberId === memberId && o.date === date) return o.shift;
  }
  const m = findMember(roster, memberId);
  if (!m) return "-";
  return patternShift(m.pattern, m.anchorDate, date);
}

export function flexOn(
  roster: Roster,
  memberId: string,
  date: string
): WorkShift[] {
  return (
    roster.flex.find((f) => f.memberId === memberId && f.date === date)
      ?.shifts ?? []
  );
}

export function shiftsInWeek(
  roster: Roster,
  memberId: string,
  date: string
): number {
  const monday = weekStart(date);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    if (shiftOn(roster, memberId, addDays(monday, i)) !== "-") n++;
  }
  return n;
}

export type Eligibility =
  | {
      ok: true;
      flex: boolean;
      /** Shifts the candidate already has that Mon-Sun week */
      shiftsThisWeek: number;
      /** Smallest rest gap around the new shift, in hours (null if none nearby) */
      restHours: number | null;
    }
  | { ok: false; reason: string };

/** Can `candidateId` take a `shift` shift on `date`? */
export function checkEligibility(
  roster: Roster,
  candidateId: string,
  date: string,
  shift: WorkShift
): Eligibility {
  const { timezone, minRestHours, maxShiftsPerWeek } = roster.rules;
  if (!findMember(roster, candidateId)) {
    return { ok: false, reason: "not on this team" };
  }

  const current = shiftOn(roster, candidateId, date);
  if (current !== "-") {
    return {
      ok: false,
      reason: `already on the ${SHIFT_DEFS[current].label.toLowerCase()} shift that day`
    };
  }

  const [start, end] = shiftInterval(date, shift, timezone);
  let restHours: number | null = null;
  // Shifts are at most 24h long, so +-2 days covers every possible clash.
  for (const offset of [-2, -1, 1, 2]) {
    const d = addDays(date, offset);
    const other = shiftOn(roster, candidateId, d);
    if (other === "-") continue;
    const [s, e] = shiftInterval(d, other, timezone);
    if (s < end && e > start) {
      return { ok: false, reason: `overlaps their shift on ${formatDate(d)}` };
    }
    const gap = (offset < 0 ? start - e : s - end) / HOUR;
    restHours = restHours === null ? gap : Math.min(restHours, gap);
    if (gap < minRestHours) {
      const when = offset < 0 ? "after" : "before";
      return {
        ok: false,
        reason: `only ${round1(gap)}h rest ${when} their ${SHIFT_DEFS[other].label.toLowerCase()} shift on ${formatDate(d)} (minimum ${minRestHours}h)`
      };
    }
  }

  const shiftsThisWeek = shiftsInWeek(roster, candidateId, date);
  if (shiftsThisWeek + 1 > maxShiftsPerWeek) {
    return {
      ok: false,
      reason: `would be their ${shiftsThisWeek + 1}th shift that week (max ${maxShiftsPerWeek})`
    };
  }

  return {
    ok: true,
    flex: flexOn(roster, candidateId, date).includes(shift),
    shiftsThisWeek,
    restHours: restHours === null ? null : round1(restHours)
  };
}

export type Candidate = {
  memberId: string;
  name: string;
  role: string;
  flex: boolean;
  shiftsThisWeek: number;
  restHours: number | null;
};

export type CandidateSearch = {
  requesterId: string;
  date: string;
  shift: WorkShift;
  candidates: Candidate[];
  excluded: { memberId: string; name: string; reason: string }[];
};

/**
 * Everyone who could cover the requester's shift on `date`, best first:
 * flex-marked people, then the lightest load that week, then by name.
 */
export function findSwapCandidates(
  roster: Roster,
  requesterId: string,
  date: string
): CandidateSearch {
  const requester = findMember(roster, requesterId);
  if (!requester) throw new Error("Unknown team member");
  const shift = shiftOn(roster, requesterId, date);
  if (shift === "-") {
    throw new Error(
      `${requester.name} is not scheduled on ${formatDate(date)}`
    );
  }

  const candidates: Candidate[] = [];
  const excluded: CandidateSearch["excluded"] = [];
  for (const m of roster.members) {
    if (m.id === requesterId) continue;
    if (m.role !== requester.role) {
      excluded.push({
        memberId: m.id,
        name: m.name,
        reason: `different role (${m.role})`
      });
      continue;
    }
    const e = checkEligibility(roster, m.id, date, shift);
    if (e.ok) {
      candidates.push({
        memberId: m.id,
        name: m.name,
        role: m.role,
        flex: e.flex,
        shiftsThisWeek: e.shiftsThisWeek,
        restHours: e.restHours
      });
    } else {
      excluded.push({ memberId: m.id, name: m.name, reason: e.reason });
    }
  }

  candidates.sort(
    (a, b) =>
      Number(b.flex) - Number(a.flex) ||
      a.shiftsThisWeek - b.shiftsThisWeek ||
      a.name.localeCompare(b.name)
  );
  return { requesterId, date, shift, candidates, excluded };
}

/** Overrides that move a shift from requester to acceptor. */
export function swapOverrides(
  requesterId: string,
  acceptorId: string,
  date: string,
  shift: WorkShift
): Override[] {
  return [
    { memberId: requesterId, date, shift: "-" },
    { memberId: acceptorId, date, shift }
  ];
}

export type RosterGrid = {
  dates: string[];
  rows: {
    memberId: string;
    name: string;
    role: string;
    pattern: string;
    shifts: ShiftCode[];
    flex: WorkShift[][];
    swapped: boolean[];
  }[];
};

export function rosterGrid(
  roster: Roster,
  startDate: string,
  days: number
): RosterGrid {
  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  return {
    dates,
    rows: roster.members.map((m) => ({
      memberId: m.id,
      name: m.name,
      role: m.role,
      pattern: PATTERNS[m.pattern].name,
      shifts: dates.map((d) => shiftOn(roster, m.id, d)),
      flex: dates.map((d) => flexOn(roster, m.id, d)),
      swapped: dates.map((d) =>
        roster.overrides.some((o) => o.memberId === m.id && o.date === d)
      )
    }))
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
