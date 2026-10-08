import { tool } from "ai";
import { z } from "zod";
import { SHIFT_DEFS, type WorkShift } from "./rotation";
import { MANAGER, OPEN_STATUSES, type Actor } from "./shared";
import { findSwapCandidates, flexOn, shiftOn } from "./swaps";
import { addDays, formatDate, isDate, localDate } from "./time";
import type { TeamAgent } from "./team-agent";

const dateSchema = z
  .string()
  .describe(
    "Local date as YYYY-MM-DD, taken from the date lookup in the system prompt"
  );

const shiftLabel = (s: string) =>
  s === "-" ? "off" : SHIFT_DEFS[s as WorkShift].label;

/**
 * Tools for one chat turn. `actor` is whoever sent the latest message;
 * members act for themselves, the manager may name a member.
 * Every execute() is deterministic code: the model picks the tool, code
 * does the dates and eligibility.
 */
export function buildTools(agent: TeamAgent, actor: Actor) {
  /** The member a tool call is about, or an error string for the model. */
  function subject(memberName?: string) {
    if (memberName && memberName.trim()) {
      const m = agent.resolveMember(memberName);
      if (!m) return { error: `No team member named "${memberName}".` };
      if (actor !== MANAGER && m.id !== actor) {
        return { error: "Members can only do this for themselves." };
      }
      return { member: m };
    }
    if (actor === MANAGER) {
      return { error: "As the manager, say which member (memberName)." };
    }
    const m = agent.getMember(actor);
    return m ? { member: m } : { error: "Unknown member." };
  }

  function badDate(date: string) {
    if (!isDate(date)) return `"${date}" is not a YYYY-MM-DD date.`;
    const today = localDate(Date.now(), agent.getRules().timezone);
    if (date < today) return "That date is in the past.";
    return null;
  }

  return {
    getSchedule: tool({
      description:
        "Get the shift schedule. With memberName, one person's shifts; without it, the speaker's own (or the whole team for the manager).",
      inputSchema: z.object({
        memberName: z
          .string()
          .optional()
          .describe("Whose schedule; omit for the speaker"),
        startDate: dateSchema
          .optional()
          .describe("First date, YYYY-MM-DD; defaults to today"),
        days: z
          .number()
          .int()
          .min(1)
          .max(14)
          .optional()
          .describe("Number of days, default 7")
      }),
      execute: async ({ memberName, startDate, days }) => {
        const roster = agent.getRoster();
        const start =
          startDate && isDate(startDate)
            ? startDate
            : localDate(Date.now(), roster.rules.timezone);
        const dates = Array.from({ length: days ?? 7 }, (_, i) =>
          addDays(start, i)
        );
        let members = roster.members;
        if (memberName?.trim() || actor !== MANAGER) {
          const s = memberName?.trim()
            ? agent.resolveMember(memberName)
            : agent.getMember(actor);
          if (!s) return { error: `No team member named "${memberName}".` };
          members = [s];
        }
        return members.map((m) => ({
          name: m.name,
          role: m.role,
          shifts: dates.map((d) => ({
            date: formatDate(d),
            shift: shiftLabel(shiftOn(roster, m.id, d)),
            flex: flexOn(roster, m.id, d).map((f) => SHIFT_DEFS[f].label)
          }))
        }));
      }
    }),

    setFlexAvailability: tool({
      description:
        "Record dates when someone is willing to pick up extra shifts (or clear them). Coworkers marked flex are offered swaps first.",
      inputSchema: z.object({
        dates: z.array(dateSchema).min(1).max(14),
        shift: z
          .enum(["day", "night", "either", "none"])
          .describe('"none" clears flex for those dates'),
        memberName: z
          .string()
          .optional()
          .describe("Manager only: who to set it for")
      }),
      execute: async ({ dates, shift, memberName }) => {
        const s = subject(memberName);
        if ("error" in s) return s;
        const shifts: WorkShift[] =
          shift === "day"
            ? ["D"]
            : shift === "night"
              ? ["N"]
              : shift === "either"
                ? ["D", "N"]
                : [];
        const roster = agent.getRoster();
        const saved: string[] = [];
        const skipped: string[] = [];
        for (const d of dates) {
          const err = badDate(d);
          if (err) {
            skipped.push(`${d}: ${err}`);
            continue;
          }
          const working = shiftOn(roster, s.member.id, d);
          if (working !== "-" && shifts.length > 0) {
            skipped.push(
              `${formatDate(d)}: already working the ${shiftLabel(working)} shift`
            );
            continue;
          }
          agent.setFlexAvailability(s.member.id, d, shifts);
          saved.push(formatDate(d));
        }
        return { member: s.member.name, flex: shift, saved, skipped };
      }
    }),

    findSwapCandidates: tool({
      description:
        "Preview who could cover someone's shift on a date, ranked (flex-marked first), with reasons others are excluded. Does not send anything.",
      inputSchema: z.object({
        date: dateSchema,
        memberName: z
          .string()
          .optional()
          .describe("Whose shift; omit for the speaker")
      }),
      execute: async ({ date, memberName }) => {
        const s = subject(memberName);
        if ("error" in s) return s;
        const err = badDate(date);
        if (err) return { error: err };
        try {
          const r = findSwapCandidates(agent.getRoster(), s.member.id, date);
          return {
            shift: `${shiftLabel(r.shift)} on ${formatDate(date)}`,
            eligible: r.candidates.map((c) => ({
              name: c.name,
              markedFlex: c.flex,
              shiftsThatWeek: c.shiftsThisWeek
            })),
            notEligible: r.excluded.map((e) => ({
              name: e.name,
              why: e.reason
            }))
          };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
    }),

    requestSwap: tool({
      description:
        "Ask coworkers to take someone's shift on a date. Checks eligibility, then offers it to every eligible coworker; the first to accept goes to the manager for approval.",
      inputSchema: z.object({
        date: dateSchema,
        note: z
          .string()
          .optional()
          .describe("Optional short note for coworkers"),
        memberName: z.string().optional().describe("Manager only: whose shift")
      }),
      execute: async ({ date, note, memberName }) => {
        const s = subject(memberName);
        if ("error" in s) return s;
        const err = badDate(date);
        if (err) return { error: err };
        try {
          const r = await agent.createSwapRequest(s.member.id, date, note);
          if (!r.ok) {
            return {
              error: r.error,
              notEligible:
                "excluded" in r
                  ? r.excluded?.map((e) => ({ name: e.name, why: e.reason }))
                  : undefined
            };
          }
          return {
            status:
              "Offer sent. Coworkers accept in their Inbox; then the manager approves.",
            shift: `${r.shift} on ${r.date}`,
            offeredTo: r.offeringTo
          };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
    }),

    listMyRequests: tool({
      description:
        "List swap requests the speaker made or was offered (all recent requests for the manager).",
      inputSchema: z.object({}),
      execute: async () => {
        const reqs = agent
          .getRequests(50)
          .filter(
            (r) =>
              actor === MANAGER ||
              r.requesterId === actor ||
              r.offeredTo.includes(actor)
          );
        return reqs.slice(0, 10).map((r) => ({
          requestId: r.id,
          what: agent.describe(r),
          status: r.status,
          open: OPEN_STATUSES.includes(r.status),
          coveredBy: r.acceptorId ? agent.actorName(r.acceptorId) : null,
          offeredTo: r.offeredTo.map((id) => agent.actorName(id))
        }));
      }
    }),

    cancelRequest: tool({
      description: "Cancel an open swap request (requester or manager only).",
      inputSchema: z.object({
        requestId: z.string().describe("From listMyRequests")
      }),
      execute: async ({ requestId }) => agent.cancelRequest(requestId, actor)
    })
  };
}
