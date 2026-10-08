/**
 * Which tools the model may call on the next step of a chat turn.
 *
 * Llama 3.3 on Workers AI calls a tool on every step while tools are
 * offered, even after it has the result it needs, so a turn never ends in
 * a reply. We narrow the offer step by step instead:
 * - after an action tool (or the candidate preview) has run, offer nothing,
 *   so the next step must be the answer;
 * - read-only tools can lead to one follow-up (listMyRequests ->
 *   cancelRequest, getSchedule -> setFlexAvailability) but never repeat;
 * - after MAX_TOOL_STEPS tool steps, offer nothing.
 */
export const TOOL_NAMES = [
  "getSchedule",
  "setFlexAvailability",
  "findSwapCandidates",
  "requestSwap",
  "listMyRequests",
  "cancelRequest"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const READ_ONLY: ReadonlySet<string> = new Set([
  "getSchedule",
  "listMyRequests"
]);
const MAX_TOOL_STEPS = 2;

export function nextStepTools(
  steps: readonly { toolCalls: readonly { toolName: string }[] }[]
): ToolName[] {
  const called = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
  if (called.length === 0) return [...TOOL_NAMES];
  const toolSteps = steps.filter((s) => s.toolCalls.length > 0).length;
  if (toolSteps >= MAX_TOOL_STEPS) return [];
  if (called.some((name) => !READ_ONLY.has(name))) return [];
  return TOOL_NAMES.filter((name) => !called.includes(name));
}
