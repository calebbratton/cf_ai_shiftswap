import { describe, expect, it } from "vitest";
import { TOOL_NAMES, nextStepTools } from "./step-policy";

const step = (...toolNames: string[]) => ({
  toolCalls: toolNames.map((toolName) => ({ toolName }))
});

describe("nextStepTools", () => {
  it("offers every tool on the first step", () => {
    expect(nextStepTools([])).toEqual([...TOOL_NAMES]);
  });

  it("forces a reply after an action tool", () => {
    expect(nextStepTools([step("requestSwap")])).toEqual([]);
    expect(nextStepTools([step("setFlexAvailability")])).toEqual([]);
    expect(nextStepTools([step("findSwapCandidates")])).toEqual([]);
  });

  it("allows one follow-up after a read-only tool, without repeating it", () => {
    const next = nextStepTools([step("listMyRequests")]);
    expect(next).toContain("cancelRequest");
    expect(next).not.toContain("listMyRequests");
  });

  it("stops after two tool steps", () => {
    expect(
      nextStepTools([step("getSchedule"), step("listMyRequests")])
    ).toEqual([]);
  });

  it("ignores steps that only produced text", () => {
    expect(nextStepTools([step()])).toEqual([...TOOL_NAMES]);
  });
});
