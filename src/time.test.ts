import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatDate,
  isDate,
  resolveDate,
  localDate,
  weekStart,
  weekday,
  zonedTimeToUtc
} from "./time";

const iso = (ms: number) => new Date(ms).toISOString();

describe("zonedTimeToUtc", () => {
  it("converts New York daylight time", () => {
    expect(iso(zonedTimeToUtc("2026-10-13", "09:00", "America/New_York"))).toBe(
      "2026-10-13T13:00:00.000Z"
    );
  });

  it("converts New York standard time after the fall-back", () => {
    expect(iso(zonedTimeToUtc("2026-11-02", "09:00", "America/New_York"))).toBe(
      "2026-11-02T14:00:00.000Z"
    );
  });

  it("handles zones east of UTC with half-hour offsets", () => {
    expect(iso(zonedTimeToUtc("2026-10-13", "09:00", "Asia/Kolkata"))).toBe(
      "2026-10-13T03:30:00.000Z"
    );
  });

  it("resolves a spring-forward gap to after the gap", () => {
    // 02:30 does not exist on 2026-03-08 in New York; 03:30 EDT does.
    expect(iso(zonedTimeToUtc("2026-03-08", "02:30", "America/New_York"))).toBe(
      "2026-03-08T07:30:00.000Z"
    );
  });

  it("resolves an ambiguous fall-back time to the earlier instant", () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT (UTC-4).
    expect(iso(zonedTimeToUtc("2026-11-01", "01:30", "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z"
    );
  });
});

describe("local dates", () => {
  it("returns the date on the team's wall clock, not UTC", () => {
    // 02:00 UTC on the 9th is still the evening of the 8th in New York.
    expect(
      localDate(Date.parse("2026-10-09T02:00:00Z"), "America/New_York")
    ).toBe("2026-10-08");
  });

  it("adds days across month, year and DST boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts days between dates in both directions", () => {
    expect(daysBetween("2026-10-08", "2026-10-16")).toBe(8);
    expect(daysBetween("2026-10-16", "2026-10-08")).toBe(-8);
    expect(daysBetween("2026-03-01", "2026-03-15")).toBe(14); // spans DST
  });

  it("knows weekdays and week starts", () => {
    expect(weekday("2026-10-16")).toBe(5); // Friday
    expect(weekStart("2026-10-16")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday -> prior Monday
    expect(formatDate("2026-10-16")).toBe("Fri, Oct 16");
  });

  it("validates dates", () => {
    expect(isDate("2026-10-16")).toBe(true);
    expect(isDate("2026-02-30")).toBe(false);
    expect(isDate("next friday")).toBe(false);
  });
});

describe("resolveDate", () => {
  const today = "2026-10-08"; // Thursday

  it("passes ISO dates through and rejects impossible ones", () => {
    expect(resolveDate("2026-10-16", today)).toBe("2026-10-16");
    expect(resolveDate("2026-02-30", today)).toBeNull();
  });

  it("resolves today and tomorrow", () => {
    expect(resolveDate("today", today)).toBe("2026-10-08");
    expect(resolveDate("Tomorrow", today)).toBe("2026-10-09");
  });

  it("resolves weekday names to the next occurrence after today", () => {
    expect(resolveDate("friday", today)).toBe("2026-10-09");
    expect(resolveDate("this Friday", today)).toBe("2026-10-09");
    expect(resolveDate("upcoming fri", today)).toBe("2026-10-09");
    expect(resolveDate("monday", today)).toBe("2026-10-12");
    expect(resolveDate("thursday", today)).toBe("2026-10-15"); // not today
  });

  it("returns null for things it can't read", () => {
    expect(resolveDate("someday", today)).toBeNull();
    expect(resolveDate("", today)).toBeNull();
  });
});
