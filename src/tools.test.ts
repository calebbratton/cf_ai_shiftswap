import { describe, expect, it } from "vitest";
import { coerceList } from "./tools";

describe("coerceList", () => {
  it("passes arrays through", () => {
    expect(coerceList(["2026-10-12"])).toEqual(["2026-10-12"]);
  });

  it("parses an array sent as a JSON string (seen from Llama 3.3)", () => {
    expect(coerceList('["2026-10-12", "2026-10-13"]')).toEqual([
      "2026-10-12",
      "2026-10-13"
    ]);
  });

  it("splits a comma-separated string", () => {
    expect(coerceList("2026-10-12, 2026-10-13")).toEqual([
      "2026-10-12",
      "2026-10-13"
    ]);
    expect(coerceList("2026-10-12")).toEqual(["2026-10-12"]);
  });
});
