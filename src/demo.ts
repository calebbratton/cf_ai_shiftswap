import type { PatternKey, WorkShift } from "./rotation";
import { addDays, weekday } from "./time";
import type { TeamAgent } from "./team-agent";

/**
 * A fictional 4 West Med-Surg team, anchored around the next Friday so
 * "find someone to take my Friday shift" always has an interesting
 * answer: one flex-marked coworker, a couple of other eligible people,
 * and others excluded for rest, role, and already working.
 */
export function seedDemoTeam(
  agent: TeamAgent,
  timezone: string,
  today: string
) {
  // First Friday after today (a week out if today is Friday).
  const fri = addDays(today, (5 - weekday(today) + 7) % 7 || 7);

  const members: {
    id: string;
    name: string;
    role: string;
    pattern: PatternKey;
    anchor: number;
  }[] = [
    // Works Tue-Fri days: the default "you".
    {
      id: "alex",
      name: "Alex Rivera",
      role: "RN",
      pattern: "fourOnFourOff",
      anchor: -3
    },
    // Off Tue-Fri, back on Saturday days.
    {
      id: "ben",
      name: "Ben Okafor",
      role: "RN",
      pattern: "fourOnFourOff",
      anchor: 1
    },
    // Nights Mon-Thu: Thursday's night ends Friday 7a.
    {
      id: "cara",
      name: "Cara Lindqvist",
      role: "RN",
      pattern: "fourOnFourOffNights",
      anchor: -4
    },
    // Pitman, off Friday, marked flex for Friday days.
    {
      id: "dev",
      name: "Dev Patel",
      role: "RN",
      pattern: "pitman",
      anchor: -11
    },
    // Off Friday, but a tech, not an RN.
    {
      id: "eve",
      name: "Eve Morales",
      role: "Tech",
      pattern: "fourOnFourOff",
      anchor: 1
    },
    // Pitman, working Friday.
    {
      id: "finn",
      name: "Finn O'Brien",
      role: "RN",
      pattern: "pitman",
      anchor: -4
    },
    // Nights from Saturday.
    {
      id: "hana",
      name: "Hana Sato",
      role: "RN",
      pattern: "fourOnFourOffNights",
      anchor: 1
    }
  ];

  const flex: { id: string; offset: number; shifts: WorkShift[] }[] = [
    { id: "dev", offset: 0, shifts: ["D"] },
    { id: "dev", offset: 1, shifts: ["D", "N"] },
    { id: "hana", offset: -1, shifts: ["N"] },
    { id: "eve", offset: 0, shifts: ["D"] },
    { id: "ben", offset: -2, shifts: ["D"] }
  ];

  agent.sql`DELETE FROM members`;
  agent.sql`DELETE FROM overrides`;
  agent.sql`DELETE FROM flex`;
  agent.sql`DELETE FROM swap_requests`;
  agent.sql`DELETE FROM notices`;
  for (const m of members) {
    agent.sql`INSERT INTO members (id, name, role, pattern, anchor_date)
              VALUES (${m.id}, ${m.name}, ${m.role}, ${m.pattern}, ${addDays(fri, m.anchor)})`;
  }
  for (const f of flex) {
    agent.sql`INSERT OR REPLACE INTO flex (member_id, date, shifts)
              VALUES (${f.id}, ${addDays(fri, f.offset)}, ${JSON.stringify(f.shifts)})`;
  }
  agent.setSetting("teamName", "4 West Med-Surg (demo)");
  agent.setSetting("timezone", timezone);
  agent.setSetting("minRestHours", "10");
  agent.setSetting("maxShiftsPerWeek", "4");
  agent.setSetting("seeded", "1");
}
