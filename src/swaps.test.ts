import { describe, expect, it } from "vitest";
import { PATTERNS, patternShift, shiftInterval } from "./rotation";
import {
  checkEligibility,
  findSwapCandidates,
  rosterGrid,
  shiftOn,
  swapOverrides,
  type Member,
  type Roster
} from "./swaps";

const iso = (ms: number) => new Date(ms).toISOString();
const FRI = "2026-10-16";

describe("rotation patterns", () => {
  it("has the documented cycle lengths", () => {
    expect(PATTERNS.pitman.cycle).toHaveLength(14);
    expect(PATTERNS.panama.cycle).toHaveLength(28);
    expect(PATTERNS.dupont.cycle).toHaveLength(28);
    expect(PATTERNS.fourOnFourOff.cycle).toHaveLength(8);
  });

  it("repeats from the anchor, including before it", () => {
    expect(patternShift("fourOnFourOff", "2026-10-13", "2026-10-13")).toBe("D");
    expect(patternShift("fourOnFourOff", "2026-10-13", "2026-10-17")).toBe("-");
    expect(patternShift("fourOnFourOff", "2026-10-13", "2026-10-21")).toBe("D");
    expect(patternShift("pitman", "2026-10-05", "2026-10-04")).toBe("-");
    expect(patternShift("pitman", "2026-10-05", "2026-09-21")).toBe("D");
  });

  it("follows DuPont's 4N 3off 3D 1off 3N 3off 4D 7off", () => {
    const days = Array.from({ length: 28 }, (_, i) =>
      patternShift("dupont", "2026-10-01", `2026-10-${String(i + 1).padStart(2, "0")}`)
    ).join("");
    expect(days).toBe("NNNN---DDD-NNN---DDDD-------");
  });

  it("puts day shifts at 7a-7p local", () => {
    const [s, e] = shiftInterval(FRI, "D", "America/New_York");
    expect(iso(s)).toBe("2026-10-16T11:00:00.000Z");
    expect(iso(e)).toBe("2026-10-16T23:00:00.000Z");
  });

  it("ends a night shift at 7a local even across the DST change", () => {
    const [s, e] = shiftInterval("2026-10-31", "N", "America/New_York");
    expect(iso(s)).toBe("2026-10-31T23:00:00.000Z"); // 7p EDT
    expect(iso(e)).toBe("2026-11-01T12:00:00.000Z"); // 7a EST: a 13h night
  });
});

// A small team, looked at for Friday Oct 16 (week of Mon Oct 12).
const members: Member[] = [
  // Works Mon-Fri (Oct 13-16) days: the requester.
  { id: "alice", name: "Alice", role: "RN", pattern: "fourOnFourOff", anchorDate: "2026-10-13" },
  // Off Tue-Fri, back on Sat days (12h after Fri's day shift ends). 3 shifts that week.
  { id: "ben", name: "Ben", role: "RN", pattern: "fourOnFourOff", anchorDate: "2026-10-17" },
  // Nights Mon-Thu: Thursday's night ends Friday 7a, zero rest.
  { id: "cara", name: "Cara", role: "RN", pattern: "fourOnFourOffNights", anchorDate: "2026-10-12" },
  // Pitman: off Friday, worked Wed-Thu. Will mark flex for Friday days.
  { id: "dev", name: "Dev", role: "RN", pattern: "pitman", anchorDate: "2026-10-05" },
  // Off Friday but a different role.
  { id: "eve", name: "Eve", role: "Tech", pattern: "fourOnFourOff", anchorDate: "2026-10-17" },
  // Already working Friday.
  { id: "finn", name: "Finn", role: "RN", pattern: "pitman", anchorDate: "2026-10-12" },
  // Off Friday but already at the weekly cap (with an override on Sunday).
  { id: "gus", name: "Gus", role: "RN", pattern: "fourOnFourOff", anchorDate: "2026-10-11" },
  // Nights from Saturday: 24h rest, 3 shifts that week. Ties with Ben.
  { id: "hana", name: "Hana", role: "RN", pattern: "fourOnFourOffNights", anchorDate: "2026-10-17" }
];

function team(overrides: Partial<Roster> = {}): Roster {
  return {
    members,
    overrides: [{ memberId: "gus", date: "2026-10-18", shift: "D" }],
    flex: [{ memberId: "dev", date: FRI, shifts: ["D"] }],
    rules: { timezone: "America/New_York", minRestHours: 10, maxShiftsPerWeek: 4 },
    ...overrides
  };
}

describe("shiftOn", () => {
  it("applies overrides on top of the pattern, latest wins", () => {
    const r = team({
      overrides: [
        { memberId: "alice", date: FRI, shift: "-" },
        { memberId: "alice", date: FRI, shift: "N" }
      ]
    });
    expect(shiftOn(r, "alice", FRI)).toBe("N");
    expect(shiftOn(r, "alice", "2026-10-15")).toBe("D");
  });
});

describe("findSwapCandidates", () => {
  const result = findSwapCandidates(team(), "alice", FRI);

  it("detects the shift being given away", () => {
    expect(result.shift).toBe("D");
  });

  it("ranks flex-marked first, then lighter week, then name", () => {
    expect(result.candidates.map((c) => c.memberId)).toEqual([
      "dev",
      "ben",
      "hana"
    ]);
    expect(result.candidates[0]).toMatchObject({ flex: true, shiftsThisWeek: 2 });
    expect(result.candidates[1]).toMatchObject({ flex: false, shiftsThisWeek: 3, restHours: 12 });
  });

  it("explains every exclusion", () => {
    const why = Object.fromEntries(result.excluded.map((e) => [e.memberId, e.reason]));
    expect(why.cara).toBe(
      "only 0h rest after their night (7p-7a) shift on Thu, Oct 15 (minimum 10h)"
    );
    expect(why.eve).toBe("different role (Tech)");
    expect(why.finn).toBe("already on the day (7a-7p) shift that day");
    expect(why.gus).toBe("would be their 5th shift that week (max 4)");
  });

  it("respects a stricter minimum rest", () => {
    const r = team({ rules: { timezone: "America/New_York", minRestHours: 13, maxShiftsPerWeek: 4 } });
    const ben = checkEligibility(r, "ben", FRI, "D");
    expect(ben).toEqual({
      ok: false,
      reason: "only 12h rest before their day (7a-7p) shift on Sat, Oct 17 (minimum 13h)"
    });
  });

  it("only counts flex for the matching shift type", () => {
    const r = team({ flex: [{ memberId: "ben", date: FRI, shifts: ["N"] }] });
    const ben = checkEligibility(r, "ben", FRI, "D");
    expect(ben.ok && ben.flex).toBe(false);
  });

  it("refuses when the requester is not working that day", () => {
    expect(() => findSwapCandidates(team(), "alice", "2026-10-17")).toThrow(
      /not scheduled/
    );
  });

  it("refuses an unknown requester", () => {
    expect(() => findSwapCandidates(team(), "zed", FRI)).toThrow(/Unknown/);
  });
});

describe("applying a swap", () => {
  it("moves the shift and the candidate is no longer eligible", () => {
    const base = team();
    const after = team({
      overrides: [...base.overrides, ...swapOverrides("alice", "dev", FRI, "D")]
    });
    expect(shiftOn(after, "alice", FRI)).toBe("-");
    expect(shiftOn(after, "dev", FRI)).toBe("D");
    // Re-checking the same swap now fails: the race guard in the workflow.
    expect(checkEligibility(after, "dev", FRI, "D").ok).toBe(false);
  });

  it("marks swapped cells in the roster grid", () => {
    const after = team({ overrides: swapOverrides("alice", "dev", FRI, "D") });
    const grid = rosterGrid(after, "2026-10-12", 7);
    expect(grid.dates).toHaveLength(7);
    const dev = grid.rows.find((r) => r.memberId === "dev")!;
    expect(dev.shifts[4]).toBe("D");
    expect(dev.swapped[4]).toBe(true);
    expect(dev.flex[4]).toEqual(["D"]);
  });
});
