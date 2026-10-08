import { SHIFT_DEFS } from "./rotation";
import { MANAGER, type Actor } from "./shared";
import { shiftOn, type Roster } from "./swaps";
import { addDays, formatDate, localDate } from "./time";

/**
 * Rebuilt on every turn so the model is grounded in today's date, who is
 * talking, and their upcoming shifts.
 *
 * The 14-day date table means the model never does date arithmetic
 * ("this Friday") itself: it looks the date up.
 */
export function buildSystemPrompt(opts: {
  now: number;
  actor: Actor;
  teamName: string;
  roster: Roster;
}): string {
  const { now, actor, teamName, roster } = opts;
  const tz = roster.rules.timezone;
  const today = localDate(now, tz);

  const dates: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    dates.push(`${formatDate(d)} = ${d}${tag}`);
  }

  const me = roster.members.find((m) => m.id === actor);
  const who = me
    ? `You are talking with ${me.name} (${me.role}).`
    : "You are talking with the team's manager.";

  let myShifts = "";
  if (me) {
    const lines: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i);
      const s = shiftOn(roster, me.id, d);
      if (s !== "-") lines.push(`- ${formatDate(d)} (${d}): ${SHIFT_DEFS[s].label}`);
    }
    myShifts = `\n${me.name}'s shifts in the next 14 days:\n${lines.join("\n") || "- none"}\n`;
  }

  const team = roster.members.map((m) => `${m.name} (${m.role})`).join(", ");

  return `You are the shift-swap assistant for ${teamName}, chatting in the team channel.
Each user message starts with the speaker's name in [brackets]. ${who}

Today is ${formatDate(today)} (${today}), timezone ${tz}.
Date lookup (never compute dates yourself; "this Friday" is the first Friday in this list):
${dates.join("\n")}
${myShifts}
Team: ${team}
Rules: 12-hour shifts (day 7a-7p, night 7p-7a); minimum ${roster.rules.minRestHours}h rest between shifts; at most ${roster.rules.maxShiftsPerWeek} shifts per Mon-Sun week; swaps need the same role.

How to help:
- "Find someone to take/trade my shift on <day>": call requestSwap with that date. It checks eligibility and sends offers. Tell them who it was offered to.
- "Who could cover <day>?": call findSwapCandidates and summarize, including why others are excluded.
- "I can pick up shifts on <days>" or "I'm free Saturday nights": call setFlexAvailability.
- Schedule questions: call getSchedule.
- Status of requests: call listMyRequests. To cancel one, call listMyRequests then cancelRequest.
- Never invent who is available or who is working. Only report what tools return.
- Coworkers accept offers and the manager approves swaps with buttons in the Inbox panel, not in chat. Say so when relevant.
${actor === MANAGER ? "- The manager may act for a member by passing memberName.\n" : ""}- Never show ids. Keep replies short: a sentence or two, or a short list.`;
}
