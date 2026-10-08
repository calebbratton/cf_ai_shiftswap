# Prompts

The assignment asks for the AI prompts used to build this project. These are
the prompts and instructions, in order, with a note on what each one produced.

The work was done with Claude (Claude Code), coordinated from a Claude project
conversation: Caleb talked to the project's assistant, which wrote briefs for
the coding session on his machine. Briefs are quoted verbatim.

The prompts the app itself sends to Llama 3.3 at runtime are in
[src/prompt.ts](src/prompt.ts) (system prompt, rebuilt every turn) and the tool
descriptions in [src/tools.ts](src/tools.ts).

---

## 1. Original request and build plan

Caleb asked for a plan for the Cloudflare AI app assignment (an AI-powered
app on Cloudflare with an LLM, workflow/coordination, user input via chat or
voice, and memory/state, in a repo prefixed `cf_ai_`). The plan below
(`AI_SCHEDULER_PLAN.md`) came out of that conversation and was the first input
to the build.

**Produced:** the spec for a meeting-scheduling agent.

<details>
<summary>AI_SCHEDULER_PLAN.md (full text)</summary>

# AI Scheduling Assistant on Cloudflare: Build Plan

A chat-based scheduling agent built on the Cloudflare Agents SDK. Written for the Cloudflare job assignment (`cf_ai_` repo) and designed to grow into a Micro SaaS.

> API names below were checked against developers.cloudflare.com/agents on 2026-10-08. The SDK moves quickly, so re-check imports when you scaffold.

---

## 1. Concept

You type something like _"book 30 min with Sam next Tue or Wed, mornings"_. The agent:

1. Parses the request (who, how long, which days, time-of-day window).
2. Checks your calendar and stored preferences.
3. Proposes 2 or 3 slots.
4. Books the slot you confirm.
5. Schedules a reminder and includes the meeting in a daily morning agenda.

It remembers your preferences: working hours, timezone, buffer time between meetings, default meeting length, and favorite contacts.

---

## 2. Rubric mapping

| Requirement                 | Implementation                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LLM**                     | Llama 3.3 on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) via `workers-ai-provider` + the AI SDK (`streamText`) with tool calling                       |
| **Workflow / coordination** | One `SchedulerAgent` per user (an `AIChatAgent`, which is a Durable Object) plus a `BookingWorkflow` (`AgentWorkflow`) for the propose, confirm, book, remind flow |
| **User input (chat/voice)** | React chat UI served as Workers static assets (or Pages) using `useAgentChat`. Voice via Realtime is a stretch goal                                                |
| **Memory / state**          | Agent's embedded SQLite (`this.sql`) for events, contacts, and prefs; `this.setState` for live UI sync; chat history persisted automatically by `AIChatAgent`      |

---

## 3. Architecture

```
Browser (React chat + week view)
   │  WebSocket (useAgentChat / useAgent)
   ▼
Worker entry ── routeAgentRequest() ──► SchedulerAgent (Durable Object, one per user)
                                           ├─ Workers AI (Llama 3.3) → tool calls
                                           ├─ SQLite (this.sql): events, prefs, contacts
                                           ├─ State (this.setState) → synced to UI
                                           ├─ this.runWorkflow("BOOKING_WORKFLOW") ─► BookingWorkflow
                                           └─ this.schedule(...) → sendReminder / dailyDigest
```

**Key imports (current SDK)**

```ts
// server
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { AgentWorkflow } from "agents/workflows";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

// client
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
```

---

## 4. Agent tools

Every tool is an AI SDK `tool({ description, inputSchema, execute })` defined inside `onChatMessage`.

| Tool             | Input                                                                                           | What it does                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `findSlots`      | `durationMin`, `dateRange` (start/end), `timeOfDay?` (`morning`/`afternoon`/`any`), `attendee?` | Computes free gaps in `events` that respect working hours, buffer, and timezone. Returns up to 3 candidates |
| `proposeBooking` | `title`, `attendees`, `candidateSlots[]`                                                        | Starts `BookingWorkflow` and returns its instance id so the UI can show confirm buttons                     |
| `createEvent`    | `title`, `start`, `end`, `attendees[]`                                                          | Inserts into `events` (used by the workflow, or directly for "just put it on my calendar")                  |
| `listEvents`     | `from`, `to`                                                                                    | Returns events in the range for "what's on my calendar tomorrow?"                                           |
| `cancelEvent`    | `eventId`                                                                                       | Deletes the event and cancels its reminder with `cancelSchedule(reminderId)`                                |
| `setPreference`  | `key`, `value`                                                                                  | Upserts into `prefs` and mirrors the change into agent state                                                |
| `saveContact`    | `name`, `email?`, `notes?`                                                                      | Stores favorite contacts so "Sam" resolves to a person                                                      |

Keep `execute` functions deterministic. The LLM decides _what_ to do, and code does the date math. Never let the model compute free slots itself.

---

## 5. Data schema (agent SQLite)

```sql
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  start       TEXT NOT NULL,      -- ISO 8601, UTC
  end         TEXT NOT NULL,      -- ISO 8601, UTC
  attendees   TEXT,               -- JSON array of contact ids / emails
  reminder_id TEXT,               -- schedule id from this.schedule()
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,         -- timezone, workStart, workEnd, bufferMin, defaultDurationMin, reminderLeadMin
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT,
  notes TEXT
);
```

Create tables in `onStart()`. Query with the tagged template, for example:

```ts
const rows = this
  .sql<Event>`SELECT * FROM events WHERE start >= ${from} AND start < ${to} ORDER BY start`;
```

**Agent state** (synced to every connected client):

```ts
type SchedulerState = {
  prefs: Record<string, string>;
  upcoming: Event[]; // next 7 days, for the week view
  pendingBooking?: { workflowId: string; slots: Slot[]; title: string };
};
```

---

## 6. Booking workflow

`BookingWorkflow extends AgentWorkflow` and is started from the agent with `this.runWorkflow("BOOKING_WORKFLOW", { title, attendees, slots })`.

Steps:

1. **propose**: write `pendingBooking` into agent state so the UI shows the slots.
2. **wait for confirm**: `waitForApproval()`. The UI's confirm button calls an agent method that runs `this.approveWorkflow(id, { slot })`; a cancel calls `this.rejectWorkflow(id)` (which surfaces as `WorkflowRejectedError`).
3. **re-check availability**: make sure the slot is still free (a race condition is a nice thing to mention in the README).
4. **create event**: insert into `events`.
5. **schedule reminder**: `this.schedule(new Date(start - leadMs), "sendReminder", { eventId })` and save the returned id as `reminder_id`.
6. **notify**: post a confirmation message to the chat and clear `pendingBooking`.

Wrangler binding:

```jsonc
"workflows": [
  { "name": "booking-workflow", "binding": "BOOKING_WORKFLOW", "class_name": "BookingWorkflow" }
]
```

Why a Workflow instead of plain code: the user may confirm minutes or hours later, and Workflows give durable waiting, retries, and per-step state for free.

---

## 7. Scheduling (reminders and digest)

`schedule(when, callback, payload?)` accepts a `Date` (specific time), a number (delay in seconds), or a cron string.

```ts
// one-off reminder
await this.schedule(new Date(reminderAt), "sendReminder", { eventId });

// daily morning agenda (register once, e.g. in onStart if not already present)
await this.schedule("0 8 * * *", "dailyDigest");

// management
await this.listSchedules({ type: "cron" });
await this.cancelSchedule(id);
```

`sendReminder` and `dailyDigest` append an assistant message to the chat (and later send email). Note: cron runs in UTC, so either convert the user's 8 a.m. to UTC or schedule per-day `Date`s from their timezone.

---

## 8. System prompt

Rebuild every turn so the model stays grounded:

```
You are a scheduling assistant. Today is {weekday}, {date}. The user's timezone is {tz}.
Working hours: {workStart}-{workEnd}. Buffer between meetings: {bufferMin} min.
Default meeting length: {defaultDurationMin} min. Known contacts: {contactNames}.
Always call findSlots before proposing times. Never invent availability.
Confirm with the user before booking. Use proposeBooking for anything with attendees.
Reply concisely and show times in the user's timezone.
```

---

## 9. Build steps

1. **Scaffold**: `npm create cloudflare@latest -- --template cloudflare/agents-starter`, name the repo `cf_ai_scheduler`.
2. **Model**: swap to Workers AI with `createWorkersAI({ binding: this.env.AI })` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Add the `ai` binding to `wrangler.jsonc`.
3. **Agent**: `SchedulerAgent extends AIChatAgent`. In `onChatMessage(onFinish, options)`, call `streamText` with the system prompt, `convertToModelMessages(this.messages)`, tools, `stopWhen: stepCountIs(5)`, and `abortSignal: options?.abortSignal`; return `result.toUIMessageStreamResponse()`.
4. **Storage**: create tables in `onStart()`. Make sure `wrangler.jsonc` has the `new_sqlite_classes` migration for the agent class.
5. **Tools**: implement `findSlots` first with unit tests (timezones and buffers are where bugs hide), then `createEvent`, `listEvents`, `cancelEvent`, `setPreference`, `saveContact`.
6. **Workflow**: add `BookingWorkflow` and its binding; wire confirm/cancel buttons to agent methods that call `approveWorkflow` / `rejectWorkflow`.
7. **Reminders**: `sendReminder` and `dailyDigest` methods plus `this.schedule()` calls.
8. **Frontend**: chat panel (`useAgentChat`) plus a simple week view and prefs panel reading agent state (`useAgent` with `onStateUpdate`).
9. **Seed data**: a "demo mode" button that fills a fake week of meetings so reviewers can try it instantly.
10. **Deploy**: `npx wrangler deploy`, then put the live URL at the top of the README.

---

## 10. Suggested repo layout

```
cf_ai_scheduler/
├─ src/
│  ├─ server.ts            # Worker entry, routeAgentRequest
│  ├─ agent.ts             # SchedulerAgent
│  ├─ tools.ts             # tool definitions
│  ├─ slots.ts             # pure findSlots logic (+ tests)
│  ├─ workflow.ts          # BookingWorkflow
│  └─ prompt.ts            # system prompt builder
├─ src/client/             # React app (chat, week view, prefs)
├─ wrangler.jsonc
├─ README.md
└─ PROMPTS.md
```

---

## 11. Submission checklist

- [ ] Repo name prefixed `cf_ai_`
- [ ] README: what it does, architecture diagram, how each rubric item is met, local run (`npm install`, `npm run dev`), deploy steps, live URL
- [ ] `PROMPTS.md` with the AI prompt history (required by the assignment)
- [ ] Live deployment that works without sign-in (demo seed data)
- [ ] Short demo video (Loom-style, 2 to 3 minutes) as a bonus
- [ ] Clean commit history showing incremental progress

---

## 12. Stretch goals (Micro SaaS path)

- **Google Calendar OAuth**: replace the internal calendar with real free/busy data and event creation.
- **Shareable booking links**: a public page per user that talks to their agent and only exposes free slots.
- **Multi-user matching**: agent-to-agent calls to intersect availability across users.
- **Voice input**: Cloudflare Realtime, or Workers AI speech-to-text feeding the same chat.
- **Email reminders**: send via an email provider from `sendReminder`.
- **Billing and auth**: per-user agent ids tied to an auth provider, plus Stripe for paid tiers.

**Tip:** keep v1 on the fake internal calendar so the agent, memory, and workflow are solid before you take on OAuth.

</details>

## 2. Build brief (scheduler)

> Build Caleb's Cloudflare job assignment app, "cf_ai_scheduler", in this folder (create it fresh; it is a new sibling of ~/projects/shifty). The attached AI_SCHEDULER_PLAN.md on the thread's root message is the spec; follow it. If you can't see the attachment, the essentials are below.
>
> Goal: a chat scheduling agent on the Cloudflare Agents SDK meeting the four rubric items: LLM (Llama 3.3 on Workers AI, @cf/meta/llama-3.3-70b-instruct-fp8-fast via workers-ai-provider + AI SDK streamText with tools), coordination (SchedulerAgent = AIChatAgent Durable Object, one per user, plus a BookingWorkflow (AgentWorkflow) for propose -> waitForApproval -> re-check availability -> create event -> schedule reminder -> notify), chat UI (React, useAgentChat, served as Workers static assets, with a week view + prefs panel from agent state), memory (agent SQLite tables events/prefs/contacts created in onStart, setState for live UI sync, chat history persisted by AIChatAgent). Tools: findSlots (pure, deterministic code in src/slots.ts with node/vitest unit tests covering timezones, buffers, working hours), proposeBooking, createEvent, listEvents, cancelEvent (also cancelSchedule the reminder), setPreference, saveContact. Reminders via this.schedule(Date, "sendReminder") and a daily digest cron. System prompt rebuilt each turn (date, tz, working hours, buffer, contacts; always call findSlots, never invent availability, confirm before booking). A "demo mode" button that seeds a fake week so reviewers can try it without signing in. Each browser gets its own agent instance (random id kept in localStorage).
>
> How:
>
> 1. Scaffold with `npm create cloudflare@latest -- --template cloudflare/agents-starter` (non-interactive flags), then adapt. The plan's imports were checked 2026-10-08 but the SDK moves: verify every API (AIChatAgent location, AgentWorkflow, runWorkflow/approveWorkflow/rejectWorkflow, schedule, useAgentChat) against the installed packages' .d.ts files and the starter, and adapt where they differ. If the workflow approval API isn't in the installed version, implement the same flow with a plain Cloudflare Workflow (step.waitForEvent) and note it in the README.
> 2. wrangler.jsonc: ai binding, durable object binding + new_sqlite_classes migration, workflows binding, assets.
> 3. Make `npm test` and `npx tsc --noEmit` pass, and smoke test with `npm run dev` (the Workers AI binding needs remote access; that's fine).
> 4. git init with clean incremental commits (scaffold, slots+tests, agent+tools, workflow, reminders, UI, docs).
> 5. README.md: live URL at top, what it does, architecture diagram, how each rubric item is met, local run, deploy steps, design notes (why code not the LLM does date math, the confirm race re-check).
> 6. PROMPTS.md (required by the assignment, keep it current): Caleb's original request and the plan as the first prompt, this brief as the next, and every substantive prompt/instruction used after that, in order, with a one-line note of what each produced.
> 7. Deploy with `npx wrangler deploy`. If wrangler isn't logged in, stop and report back exactly what Caleb needs to run (e.g. `npx wrangler login`), don't work around it. Same for creating the GitHub repo and pushing: if creating the repo (calebbratton/cf_ai_scheduler, public) or pushing is blocked, report the exact commands for Caleb to run instead of retrying.
>
> Report back to the thread session when: blocked on Caleb, deployed (with URL), and pushed.

**Produced:** scaffold from `cloudflare/agents-starter`, verification of the
installed Agents SDK APIs (`AIChatAgent`, `AgentWorkflow`, `waitForApproval`,
`runWorkflow`/`approveWorkflow`/`rejectWorkflow`, `schedule`), a pure slot finder
with 26 timezone/buffer/working-hours tests, and a first version of the agent.
Commits `Scaffold from cloudflare/agents-starter` and `Add pure slot finder…`.

## 3. Direction change: shift swaps

Caleb's idea, relayed with the new brief:

> "What if shift workers could input flex availability so someone could say
> 'can you find someone to trade shifts with me this upcoming Friday'"

Brief:

> CHANGE OF DIRECTION from Caleb: drop the meeting scheduler and build a shift-swap agent instead, same assignment rubric. Caleb's idea: "What if shift workers could input flex availability so someone could say 'can you find someone to trade shifts with me this upcoming Friday'". He answered Yes to switching.
>
> Repo/folder: rename ~/projects/cf_ai_scheduler to ~/projects/cf_ai_shiftswap (GitHub repo calebbratton/cf_ai_shiftswap, public). Keep the agents-starter scaffold and any generic work already done; remove meeting-specific code.
>
> Design:
>
> - One TeamAgent (AIChatAgent Durable Object) per team. SQLite tables: members (id, name, role, rotation pattern + anchor date), overrides (date, member, shift on/off from approved swaps), flex availability (member, date, shift types they'd pick up), swap_requests (status history). Shifts are computed from rotation patterns plus overrides. Reuse Shifty's rotation-pattern ideas from ~/projects/shifty (its pattern engine: Pitman, DuPont, Panama, 4-on-4-off etc.) where it's cheap; copying a pattern module is fine. This should later plug into Shifty's team plan.
> - LLM: Llama 3.3 on Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast) with tools: getSchedule, setFlexAvailability, findSwapCandidates, requestSwap, listMyRequests, cancelRequest. The model decides what to do; deterministic code (with unit tests) does the date math and eligibility: the candidate isn't already working that shift, has the right role, has marked flex availability or is off, respects a minimum rest gap between shifts, and gets ranked (flex-marked first). Never let the model invent availability.
> - SwapWorkflow (Cloudflare Workflow / AgentWorkflow): find eligible coworkers, offer to them (one at a time or all at once, your choice, note it in the README), wait for an acceptance with a timeout, then wait for manager approval, re-check eligibility (race), write overrides, notify everyone in chat/state. If the SDK's approve/reject helpers aren't available, use step.waitForEvent.
> - Reminders/schedules: this.schedule for expiring stale offers and a day-before shift reminder.
> - UI: chat, a week roster grid from agent state, an inbox showing offers/approvals for the current user, and an "act as" switcher (members + manager) so reviewers can play every role without signing in. Demo seed button: a team of ~6 on rotations with some flex availability. Each browser gets its own demo team id.
> - README (live URL on top, architecture, rubric mapping, run/deploy, design notes) and PROMPTS.md: keep everything already recorded, then add Caleb's direction change and this brief in order.
>
> Everything else from the first brief stands: verify SDK APIs against installed types, tests + tsc passing, incremental commits, deploy with wrangler (Caleb still needs to run `npx wrangler login`), push, and report back when blocked, deployed and pushed.

**Produced:** the pivot. Kept the scaffold and the timezone helpers (now
`src/time.ts`), removed the meeting code, and added:

- rotation patterns (`src/rotation.ts`) and the eligibility/ranking engine
  (`src/swaps.ts`), with tests;
- `TeamAgent` and its six tools;
- `SwapWorkflow`;
- the React roster/inbox/chat UI;
- these docs.

Reading Shifty's source was blocked by a permission check during the session,
so the pattern module was written from the standard published rotations
instead of being copied from Shifty.

## 4. Wrangler login

> Caleb asked why you can't run wrangler login yourself. Run `npx wrangler
login` now from the project folder (in the background if it blocks). It opens
> a Cloudflare tab in his browser for him to approve; I've told him to click
> Allow. Then confirm with `npx wrangler whoami` and carry on with the
> shift-swap build and deploy.

**Produced:** an authenticated wrangler session (after one retry: the first
attempt's OAuth callback port was busy).

## 5. Cost guardrail

> Caleb: nothing that costs money without his approval. Stay on the Cloudflare
> Workers Free plan: do not upgrade to Workers Paid, add a payment method, buy
> a domain, or enable any paid add-on. If deploy fails because a feature
> (Workflows, Durable Objects, Workers AI usage beyond the free daily
> allowance, etc.) requires a paid plan, stop and report exactly what and what
> it would cost, instead of working around it in a way that bills him.

**Produced:** deployment kept to Free-plan features only (SQLite Durable
Objects, Workflows, Workers AI free allowance), noted in the README.
