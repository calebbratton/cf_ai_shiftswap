import { describe, expect, it } from "vitest";
import {
  findSlots,
  isFree,
  localDate,
  zonedTimeToUtc,
  type FindSlotsInput,
  type SlotPrefs
} from "./slots";

const NY: SlotPrefs = {
  timezone: "America/New_York",
  workStart: "09:00",
  workEnd: "17:00",
  bufferMin: 0
};

// Thursday 2026-10-08, 08:00 in New York (EDT, UTC-4)
const NOW = new Date("2026-10-08T12:00:00Z");

function run(overrides: Partial<FindSlotsInput>) {
  return findSlots({
    durationMin: 30,
    startDate: "2026-10-13", // Tuesday
    endDate: "2026-10-13",
    events: [],
    prefs: NY,
    now: NOW,
    ...overrides
  });
}

describe("zonedTimeToUtc", () => {
  it("converts New York daylight time", () => {
    expect(
      new Date(zonedTimeToUtc("2026-10-13", "09:00", "America/New_York"))
        .toISOString()
    ).toBe("2026-10-13T13:00:00.000Z");
  });

  it("converts New York standard time after the fall-back", () => {
    expect(
      new Date(zonedTimeToUtc("2026-11-02", "09:00", "America/New_York"))
        .toISOString()
    ).toBe("2026-11-02T14:00:00.000Z");
  });

  it("handles zones east of UTC with half-hour offsets", () => {
    expect(
      new Date(zonedTimeToUtc("2026-10-13", "09:00", "Asia/Kolkata"))
        .toISOString()
    ).toBe("2026-10-13T03:30:00.000Z");
  });

  it("resolves a spring-forward gap to after the gap", () => {
    // 02:30 does not exist on 2026-03-08 in New York; 03:30 EDT does.
    expect(
      new Date(zonedTimeToUtc("2026-03-08", "02:30", "America/New_York"))
        .toISOString()
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("resolves an ambiguous fall-back time to the earlier instant", () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT (UTC-4).
    expect(
      new Date(zonedTimeToUtc("2026-11-01", "01:30", "America/New_York"))
        .toISOString()
    ).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("localDate", () => {
  it("returns the date on the user's wall clock, not UTC", () => {
    // 02:00 UTC on the 9th is still the evening of the 8th in New York.
    expect(localDate(Date.parse("2026-10-09T02:00:00Z"), "America/New_York"))
      .toBe("2026-10-08");
  });
});

describe("findSlots: working hours", () => {
  it("starts at the beginning of the working day in the user's zone", () => {
    const slots = run({ max: 1 });
    expect(slots[0].start).toBe("2026-10-13T13:00:00.000Z"); // 9:00 EDT
    expect(slots[0].end).toBe("2026-10-13T13:30:00.000Z");
    expect(slots[0].label).toBe("Tue, Oct 13, 9:00 AM - 9:30 AM");
  });

  it("never returns a slot that ends after work ends", () => {
    const slots = run({ durationMin: 60, max: 100 });
    const last = slots[slots.length - 1];
    expect(last.end).toBe("2026-10-13T21:00:00.000Z"); // 17:00 EDT
    expect(slots).toHaveLength(15); // 9:00..16:00 on the half hour
  });

  it("skips weekends by default", () => {
    const slots = run({ startDate: "2026-10-10", endDate: "2026-10-11" });
    expect(slots).toEqual([]);
  });

  it("respects custom work days", () => {
    const slots = run({
      startDate: "2026-10-10",
      endDate: "2026-10-10",
      prefs: { ...NY, workDays: [6] }
    });
    expect(slots.length).toBeGreaterThan(0);
  });

  it("does not offer times in the past", () => {
    const slots = run({
      startDate: "2026-10-08",
      endDate: "2026-10-08",
      now: new Date("2026-10-08T18:10:00Z"), // 14:10 EDT
      max: 1
    });
    expect(slots[0].start).toBe("2026-10-08T18:30:00.000Z"); // 14:30 EDT
  });
});

describe("findSlots: time of day", () => {
  it("limits morning to before noon", () => {
    const slots = run({ timeOfDay: "morning", durationMin: 60, max: 100 });
    expect(slots.every((s) => s.end <= "2026-10-13T16:00:00.000Z")).toBe(true);
    expect(slots).toHaveLength(5); // 9:00..11:00
  });

  it("starts afternoon at noon", () => {
    const slots = run({ timeOfDay: "afternoon", max: 1 });
    expect(slots[0].start).toBe("2026-10-13T16:00:00.000Z");
  });

  it("returns nothing if work ends before noon and afternoon is asked", () => {
    const slots = run({
      timeOfDay: "afternoon",
      prefs: { ...NY, workStart: "07:00", workEnd: "11:00" }
    });
    expect(slots).toEqual([]);
  });
});

describe("findSlots: busy time and buffers", () => {
  const busy = [
    { start: "2026-10-13T13:00:00Z", end: "2026-10-13T14:00:00Z" } // 9-10 EDT
  ];

  it("skips busy intervals", () => {
    const slots = run({ events: busy, max: 1 });
    expect(slots[0].start).toBe("2026-10-13T14:00:00.000Z"); // 10:00
  });

  it("adds the buffer after a meeting", () => {
    const slots = run({
      events: busy,
      prefs: { ...NY, bufferMin: 15 },
      max: 1
    });
    expect(slots[0].start).toBe("2026-10-13T14:30:00.000Z"); // 10:30
  });

  it("adds the buffer before a meeting", () => {
    const later = [
      { start: "2026-10-13T14:00:00Z", end: "2026-10-13T15:00:00Z" } // 10-11
    ];
    const slots = run({
      events: later,
      prefs: { ...NY, bufferMin: 10 },
      timeOfDay: "morning",
      max: 100
    });
    // 9:00-9:30 is fine (30 min gap); 9:30-10:00 touches the buffer.
    expect(slots.map((s) => s.start)).toEqual([
      "2026-10-13T13:00:00.000Z",
      "2026-10-13T15:30:00.000Z"
    ]);
  });

  it("treats back-to-back meetings as free when the buffer is zero", () => {
    expect(
      isFree(
        Date.parse("2026-10-13T14:00:00Z"),
        Date.parse("2026-10-13T14:30:00Z"),
        busy,
        0
      )
    ).toBe(true);
  });

  it("handles events that span the whole working day", () => {
    const allDay = [
      { start: "2026-10-13T04:00:00Z", end: "2026-10-14T04:00:00Z" }
    ];
    expect(run({ events: allDay })).toEqual([]);
  });
});

describe("findSlots: spreading and timezones", () => {
  it("spreads results across days", () => {
    const slots = run({ startDate: "2026-10-13", endDate: "2026-10-14" });
    expect(slots.map((s) => s.start.slice(0, 10))).toEqual([
      "2026-10-13",
      "2026-10-13",
      "2026-10-14"
    ]);
  });

  it("uses the user's zone, not UTC, for working hours", () => {
    const tokyo = run({
      prefs: { ...NY, timezone: "Asia/Tokyo" },
      max: 1
    });
    expect(tokyo[0].start).toBe("2026-10-13T00:00:00.000Z"); // 9:00 JST
    expect(tokyo[0].label).toBe("Tue, Oct 13, 9:00 AM - 9:30 AM");
  });

  it("keeps 9am local across a DST change", () => {
    const slots = run({
      startDate: "2026-10-30",
      endDate: "2026-11-02",
      now: new Date("2026-10-29T00:00:00Z"),
      max: 2
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-10-30T13:00:00.000Z", // Fri 9:00 EDT
      "2026-11-02T14:00:00.000Z" // Mon 9:00 EST
    ]);
  });
});

describe("findSlots: validation", () => {
  it("rejects an unknown timezone", () => {
    expect(() => run({ prefs: { ...NY, timezone: "Mars/Olympus" } })).toThrow();
  });

  it("rejects a reversed range", () => {
    expect(() =>
      run({ startDate: "2026-10-14", endDate: "2026-10-13" })
    ).toThrow(/before/);
  });

  it("rejects a non-positive duration", () => {
    expect(() => run({ durationMin: 0 })).toThrow(/positive/);
  });

  it("caps the range length", () => {
    expect(() =>
      run({ startDate: "2026-10-01", endDate: "2026-12-31" })
    ).toThrow(/limited/);
  });
});
