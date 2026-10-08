import { callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type UIMessage
} from "ai";
import { buildSystemPrompt } from "./prompt";
import { buildTools } from "./tools";
import { seedDemoTeam } from "./demo";
import {
  SHIFT_DEFS,
  isPatternKey,
  shiftInterval,
  type ShiftCode,
  type WorkShift
} from "./rotation";
import {
  DEFAULT_RULES,
  checkEligibility,
  findMember,
  findSwapCandidates,
  rosterGrid,
  swapOverrides,
  type Member,
  type Roster,
  type TeamRules
} from "./swaps";
import {
  MANAGER,
  OPEN_STATUSES,
  type Actor,
  type Notice,
  type SwapRequest,
  type SwapStatus,
  type TeamState
} from "./shared";
import {
  HOUR,
  addDays,
  assertTimezone,
  formatDate,
  localDate,
  weekStart
} from "./time";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** How long coworkers have to answer an offer (capped by the shift start). */
const OFFER_TTL_MS = 48 * HOUR;

type RequestRow = {
  id: string;
  requester_id: string;
  date: string;
  shift: WorkShift;
  status: SwapStatus;
  offered_to: string;
  declined_by: string;
  acceptor_id: string | null;
  note: string | null;
  workflow_id: string | null;
  expiry_schedule_id: string | null;
  expires_at: string | null;
  history: string;
  created_at: string;
};

function rowToRequest(r: RequestRow): SwapRequest {
  return {
    id: r.id,
    requesterId: r.requester_id,
    date: r.date,
    shift: r.shift,
    status: r.status,
    offeredTo: JSON.parse(r.offered_to) as string[],
    declinedBy: JSON.parse(r.declined_by) as string[],
    acceptorId: r.acceptor_id,
    note: r.note,
    workflowId: r.workflow_id,
    expiresAt: r.expires_at,
    history: JSON.parse(r.history) as SwapRequest["history"],
    createdAt: r.created_at
  };
}

/**
 * One instance per team. Owns the roster (rotation patterns + overrides),
 * flex availability and swap requests in its SQLite, mirrors a view of it
 * into agent state for the UI, runs the chat, and coordinates SwapWorkflow.
 */
export class TeamAgent extends AIChatAgent<Env, TeamState> {
  maxPersistedMessages = 200;

  initialState: TeamState = {
    seeded: false,
    teamName: "",
    today: "",
    rules: { timezone: "UTC", ...DEFAULT_RULES },
    members: [],
    grid: { dates: [], rows: [] },
    requests: [],
    notices: []
  };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      pattern TEXT NOT NULL,
      anchor_date TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS overrides (
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      shift TEXT NOT NULL,
      swap_id TEXT,
      PRIMARY KEY (member_id, date))`;
    this.sql`CREATE TABLE IF NOT EXISTS flex (
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      shifts TEXT NOT NULL,
      PRIMARY KEY (member_id, date))`;
    this.sql`CREATE TABLE IF NOT EXISTS swap_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      date TEXT NOT NULL,
      shift TEXT NOT NULL,
      status TEXT NOT NULL,
      offered_to TEXT NOT NULL DEFAULT '[]',
      declined_by TEXT NOT NULL DEFAULT '[]',
      acceptor_id TEXT,
      note TEXT,
      workflow_id TEXT,
      expiry_schedule_id TEXT,
      expires_at TEXT,
      history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL)`;
    this.refreshState();
  }

  // ── Chat turn ─────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const actor = this.currentActor();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: buildSystemPrompt({
        now: Date.now(),
        actor,
        teamName: this.getSetting("teamName") ?? "Demo team",
        roster: this.getRoster()
      }),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.withSpeakers()),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildTools(this, actor),
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /** The chat is a team channel: each user message carries who sent it. */
  currentActor(): Actor {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      const id = (m.metadata as { actorId?: string } | undefined)?.actorId;
      if (id === MANAGER || (id && this.getMember(id))) return id;
      break;
    }
    return MANAGER;
  }

  /** Prefixes user messages with the speaker's name so the model can tell people apart. */
  private withSpeakers(): UIMessage[] {
    return this.messages.map((m) => {
      if (m.role !== "user") return m;
      const id = (m.metadata as { actorId?: string } | undefined)?.actorId;
      return {
        ...m,
        parts: [
          { type: "text" as const, text: `[${this.actorName(id ?? MANAGER)}]` },
          ...m.parts
        ]
      };
    });
  }

  // ── Storage ───────────────────────────────────────────────────────

  getSetting(key: string): string | undefined {
    return this.sql<{ value: string }>`
      SELECT value FROM settings WHERE key = ${key}`[0]?.value;
  }

  setSetting(key: string, value: string): void {
    this.sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${key}, ${value})`;
  }

  getRules(): TeamRules {
    return {
      timezone: this.getSetting("timezone") ?? "UTC",
      minRestHours:
        Number(this.getSetting("minRestHours")) || DEFAULT_RULES.minRestHours,
      maxShiftsPerWeek:
        Number(this.getSetting("maxShiftsPerWeek")) ||
        DEFAULT_RULES.maxShiftsPerWeek
    };
  }

  getMembers(): Member[] {
    return this.sql<{
      id: string;
      name: string;
      role: string;
      pattern: string;
      anchor_date: string;
    }>`SELECT * FROM members ORDER BY rowid`.flatMap((r) =>
      isPatternKey(r.pattern)
        ? [
            {
              id: r.id,
              name: r.name,
              role: r.role,
              pattern: r.pattern,
              anchorDate: r.anchor_date
            }
          ]
        : []
    );
  }

  getMember(id: string): Member | undefined {
    return this.getMembers().find((m) => m.id === id);
  }

  /** Case-insensitive match on full name or first name. */
  resolveMember(name: string): Member | undefined {
    const q = name.trim().toLowerCase();
    const members = this.getMembers();
    return (
      members.find((m) => m.name.toLowerCase() === q) ??
      members.find((m) => m.name.toLowerCase().split(" ")[0] === q) ??
      members.find((m) => m.name.toLowerCase().startsWith(q))
    );
  }

  actorName(actor: Actor): string {
    if (actor === MANAGER) return "Manager";
    return this.getMember(actor)?.name ?? "Unknown";
  }

  /** Everything the pure swap engine needs, loaded from SQLite. */
  getRoster(): Roster {
    // Only nearby dates matter for eligibility and the two-week grid.
    const today = localDate(Date.now(), this.getRules().timezone);
    const from = addDays(weekStart(today), -7);
    const overrides = this.sql<{
      member_id: string;
      date: string;
      shift: ShiftCode;
    }>`SELECT * FROM overrides WHERE date >= ${from}`.map((o) => ({
      memberId: o.member_id,
      date: o.date,
      shift: o.shift
    }));
    const flex = this.sql<{ member_id: string; date: string; shifts: string }>`
      SELECT * FROM flex WHERE date >= ${from}`.map((f) => ({
      memberId: f.member_id,
      date: f.date,
      shifts: JSON.parse(f.shifts) as WorkShift[]
    }));
    return { members: this.getMembers(), overrides, flex, rules: this.getRules() };
  }

  setFlexAvailability(memberId: string, date: string, shifts: WorkShift[]) {
    if (shifts.length === 0) {
      this.sql`DELETE FROM flex WHERE member_id = ${memberId} AND date = ${date}`;
    } else {
      this.sql`INSERT OR REPLACE INTO flex (member_id, date, shifts)
               VALUES (${memberId}, ${date}, ${JSON.stringify(shifts)})`;
    }
    this.refreshState();
  }

  getRequest(id: string): SwapRequest | undefined {
    const r = this.sql<RequestRow>`SELECT * FROM swap_requests WHERE id = ${id}`;
    return r[0] ? rowToRequest(r[0]) : undefined;
  }

  getRequests(limit = 50): SwapRequest[] {
    return this.sql<RequestRow>`
      SELECT * FROM swap_requests ORDER BY created_at DESC LIMIT ${limit}`.map(
      rowToRequest
    );
  }

  private setStatus(
    id: string,
    status: SwapStatus,
    note?: string,
    extra: { acceptorId?: string; offeredTo?: string[]; declinedBy?: string[] } = {}
  ): SwapRequest {
    const req = this.getRequest(id);
    if (!req) throw new Error("Unknown request");
    const history = [
      ...req.history,
      { at: new Date().toISOString(), status, ...(note ? { note } : {}) }
    ];
    this.sql`UPDATE swap_requests SET
      status = ${status},
      history = ${JSON.stringify(history)},
      acceptor_id = ${extra.acceptorId ?? req.acceptorId},
      offered_to = ${JSON.stringify(extra.offeredTo ?? req.offeredTo)},
      declined_by = ${JSON.stringify(extra.declinedBy ?? req.declinedBy)}
      WHERE id = ${id}`;
    this.refreshState();
    return this.getRequest(id)!;
  }

  notify(to: string, text: string): void {
    this.sql`INSERT INTO notices (id, to_id, text, at)
             VALUES (${crypto.randomUUID()}, ${to}, ${text}, ${new Date().toISOString()})`;
    this.refreshState();
  }

  /** Appends an assistant message to the team chat without an LLM turn. */
  async postToChat(text: string): Promise<void> {
    const msg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }]
    };
    await this.persistMessages([...this.messages, msg]);
  }

  describe(req: SwapRequest): string {
    return `${this.actorName(req.requesterId)}'s ${SHIFT_DEFS[req.shift].label.toLowerCase()} shift on ${formatDate(req.date)}`;
  }

  /** Pushes the view the UI needs into agent state (synced to every client). */
  refreshState(): void {
    const roster = this.getRoster();
    const today = localDate(Date.now(), roster.rules.timezone);
    this.setState({
      seeded: this.getSetting("seeded") === "1",
      teamName: this.getSetting("teamName") ?? "",
      today,
      rules: roster.rules,
      members: roster.members,
      grid: rosterGrid(roster, weekStart(today), 14),
      requests: this.getRequests(),
      notices: this.sql<{ id: string; to_id: string; text: string; at: string }>`
        SELECT * FROM notices ORDER BY at DESC LIMIT 50`.map((n) => ({
        id: n.id,
        to: n.to_id,
        text: n.text,
        at: n.at
      })) satisfies Notice[]
    });
  }

  // ── Swap requests (called by tools and UI) ────────────────────────

  /**
   * Creates a request and starts SwapWorkflow. Runs the eligibility check
   * first so the requester hears "nobody can cover" immediately.
   */
  async createSwapRequest(requesterId: string, date: string, note?: string) {
    const search = findSwapCandidates(this.getRoster(), requesterId, date);
    const open = this.getRequests(200).find(
      (r) =>
        r.requesterId === requesterId &&
        r.date === date &&
        OPEN_STATUSES.includes(r.status)
    );
    if (open) {
      return { ok: false as const, error: "There is already an open request for that shift.", requestId: open.id };
    }
    if (search.candidates.length === 0) {
      return {
        ok: false as const,
        error: "Nobody on the team is eligible to cover that shift.",
        excluded: search.excluded
      };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql`INSERT INTO swap_requests (id, requester_id, date, shift, status, note, history, created_at)
      VALUES (${id}, ${requesterId}, ${date}, ${search.shift}, 'searching', ${note ?? null},
              ${JSON.stringify([{ at: now, status: "searching" }])}, ${now})`;
    const workflowId = await this.runWorkflow("SWAP_WORKFLOW", { requestId: id });
    this.sql`UPDATE swap_requests SET workflow_id = ${workflowId} WHERE id = ${id}`;
    this.refreshState();
    return {
      ok: true as const,
      requestId: id,
      shift: SHIFT_DEFS[search.shift].label,
      date: formatDate(date),
      offeringTo: search.candidates.map((c) => c.name)
    };
  }

  /** Workflow step: who should get the offer right now. */
  candidatesFor(requestId: string): string[] {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "searching") return [];
    try {
      return findSwapCandidates(this.getRoster(), req.requesterId, req.date)
        .candidates.map((c) => c.memberId);
    } catch {
      return [];
    }
  }

  /**
   * Workflow step: offer the shift to every eligible coworker at once and
   * schedule the offer's expiry. First to accept wins.
   */
  async offerTo(requestId: string, memberIds: string[]): Promise<void> {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "searching") return;
    const [shiftStart] = shiftInterval(req.date, req.shift, this.getRules().timezone);
    const expiresAt = Math.min(Date.now() + OFFER_TTL_MS, shiftStart - 2 * HOUR);
    const sched = await this.schedule(
      new Date(Math.max(expiresAt, Date.now() + 60_000)),
      "expireRequest",
      { requestId }
    );
    this.sql`UPDATE swap_requests SET expiry_schedule_id = ${sched.id},
             expires_at = ${new Date(expiresAt).toISOString()} WHERE id = ${requestId}`;
    this.setStatus(requestId, "offered", undefined, { offeredTo: memberIds });
    for (const id of memberIds) {
      this.notify(id, `${this.describe(req)} is up for grabs. Can you take it?`);
    }
  }

  @callable()
  async acceptOffer(requestId: string, memberId: string) {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "offered") {
      return { ok: false, error: "This offer is no longer open." };
    }
    if (!req.offeredTo.includes(memberId) || req.declinedBy.includes(memberId)) {
      return { ok: false, error: "This offer wasn't sent to you." };
    }
    const check = checkEligibility(this.getRoster(), memberId, req.date, req.shift);
    if (!check.ok) return { ok: false, error: `You can't take it: ${check.reason}.` };

    // Claim synchronously so a second accept that arrives right after sees
    // status "accepted" and is refused: first to accept wins.
    this.setStatus(requestId, "accepted", `${this.actorName(memberId)} accepted`, {
      acceptorId: memberId
    });
    await this.cancelExpiry(requestId);
    this.notify(MANAGER, `${this.actorName(memberId)} wants to take ${this.describe(req)}. Approve?`);
    this.notify(req.requesterId, `${this.actorName(memberId)} accepted your swap. Waiting on manager approval.`);
    await this.sendWorkflowEvent("SWAP_WORKFLOW", req.workflowId!, {
      type: "accepted",
      payload: { memberId }
    });
    return { ok: true };
  }

  @callable()
  async declineOffer(requestId: string, memberId: string) {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "offered" || !req.offeredTo.includes(memberId)) return;
    const declinedBy = [...new Set([...req.declinedBy, memberId])];
    this.setStatus(requestId, "offered", `${this.actorName(memberId)} declined`, { declinedBy });
    if (req.offeredTo.every((id) => declinedBy.includes(id))) {
      await this.closeRequest(requestId, "unfilled", "Everyone declined");
    }
  }

  @callable()
  async approveSwap(requestId: string) {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "accepted" || !req.workflowId) return;
    await this.approveWorkflow(req.workflowId, { metadata: { by: MANAGER } });
  }

  @callable()
  async rejectSwap(requestId: string) {
    const req = this.getRequest(requestId);
    if (!req || req.status !== "accepted" || !req.workflowId) return;
    // Record the outcome first: waitForApproval reports the rejection back
    // through onWorkflowError, which must find the request already closed.
    await this.closeRequest(requestId, "declined", "Manager declined", true);
    await this.rejectWorkflow(req.workflowId, { reason: "Manager declined" });
  }

  /** Requester or manager only. */
  async cancelRequest(requestId: string, actor: Actor) {
    const req = this.getRequest(requestId);
    if (!req) return { ok: false, error: "No such request." };
    if (actor !== MANAGER && actor !== req.requesterId) {
      return { ok: false, error: "Only the requester or the manager can cancel it." };
    }
    if (!OPEN_STATUSES.includes(req.status)) {
      return { ok: false, error: `It is already ${req.status}.` };
    }
    await this.closeRequest(requestId, "cancelled", `Cancelled by ${this.actorName(actor)}`);
    return { ok: true };
  }

  @callable()
  async cancelRequestFromUI(requestId: string, actor: Actor) {
    return this.cancelRequest(requestId, actor);
  }

  /**
   * Ends a request. Idempotent: a second close (e.g. the workflow's error
   * callback after a cancel) is ignored. Stops the workflow if it is still
   * waiting, unless the workflow itself is the caller.
   */
  async closeRequest(
    requestId: string,
    status: SwapStatus,
    note?: string,
    fromWorkflow = false
  ): Promise<void> {
    const req = this.getRequest(requestId);
    if (!req || !OPEN_STATUSES.includes(req.status)) return;
    this.setStatus(requestId, status, note);
    await this.cancelExpiry(requestId);
    if (!fromWorkflow && req.workflowId) {
      await this.terminateWorkflow(req.workflowId).catch(() => {});
    }
    const what = this.describe(req);
    const message: Record<string, string> = {
      cancelled: `The swap request for ${what} was cancelled.`,
      expired: `Nobody took ${what} in time, so the request expired.`,
      unfilled: `Everyone declined ${what}.`,
      declined: `The manager declined the swap for ${what}.`,
      failed: `The swap for ${what} couldn't be applied: ${note ?? "the roster changed"}.`
    };
    if (message[status]) {
      this.notify(req.requesterId, message[status]);
      await this.postToChat(message[status]);
    }
  }

  private async cancelExpiry(requestId: string) {
    const id = this.sql<{ expiry_schedule_id: string | null }>`
      SELECT expiry_schedule_id FROM swap_requests WHERE id = ${requestId}`[0]
      ?.expiry_schedule_id;
    if (id) {
      await this.cancelSchedule(id);
      this.sql`UPDATE swap_requests SET expiry_schedule_id = NULL WHERE id = ${requestId}`;
    }
  }

  /** Workflow step: confirm the acceptance was recorded (idempotent). */
  confirmAccepted(requestId: string, memberId: string): boolean {
    const req = this.getRequest(requestId);
    return !!req && req.status === "accepted" && req.acceptorId === memberId;
  }

  /**
   * Workflow step: re-check eligibility and write the overrides in one
   * synchronous call. No await between check and write, so nothing that
   * happened while the manager was deciding can slip in between.
   */
  applySwap(requestId: string): { ok: boolean; reason: string | null } {
    const req = this.getRequest(requestId);
    if (!req || !req.acceptorId) return { ok: false, reason: "request not found" };
    if (req.status === "approved") return { ok: true, reason: null };
    if (req.status !== "accepted") return { ok: false, reason: `request is ${req.status}` };
    const roster = this.getRoster();
    const requesterShift = roster.overrides.find(
      (o) => o.memberId === req.requesterId && o.date === req.date
    )?.shift;
    if (requesterShift === "-") {
      return { ok: false, reason: "the shift was already given away" };
    }
    const check = checkEligibility(roster, req.acceptorId, req.date, req.shift);
    if (!check.ok) return { ok: false, reason: `${this.actorName(req.acceptorId)} is ${check.reason}` };
    for (const o of swapOverrides(req.requesterId, req.acceptorId, req.date, req.shift)) {
      this.sql`INSERT OR REPLACE INTO overrides (member_id, date, shift, swap_id)
               VALUES (${o.memberId}, ${o.date}, ${o.shift}, ${requestId})`;
    }
    this.setStatus(requestId, "approved", "Approved by manager");
    return { ok: true, reason: null };
  }

  /** Workflow step: day-before reminder for whoever picked the shift up. */
  async scheduleShiftReminder(requestId: string): Promise<string | null> {
    const req = this.getRequest(requestId);
    if (!req?.acceptorId) return null;
    const [start] = shiftInterval(req.date, req.shift, this.getRules().timezone);
    const at = start - 24 * HOUR;
    if (at <= Date.now()) return null;
    const s = await this.schedule(new Date(at), "shiftReminder", { requestId });
    return s.id;
  }

  /** Workflow step: tell everyone. */
  async announceSwap(requestId: string): Promise<void> {
    const req = this.getRequest(requestId);
    if (!req?.acceptorId) return;
    const text = `✅ ${this.actorName(req.acceptorId)} is now covering ${this.describe(req)}. The roster is updated.`;
    this.notify("all", text);
    await this.postToChat(text);
  }

  async onWorkflowError(_name: string, workflowId: string, error: string) {
    const req = this.getRequests(200).find((r) => r.workflowId === workflowId);
    if (!req) return;
    // Rejections and timeouts are normally closed by the workflow itself;
    // this catches anything it couldn't handle.
    await this.closeRequest(req.id, "failed", error, true);
  }

  // ── Scheduled callbacks ───────────────────────────────────────────

  async expireRequest(payload: { requestId: string }): Promise<void> {
    const req = this.getRequest(payload.requestId);
    if (!req || req.status !== "offered") return;
    this.sql`UPDATE swap_requests SET expiry_schedule_id = NULL WHERE id = ${req.id}`;
    await this.closeRequest(req.id, "expired", "Offer expired");
  }

  async shiftReminder(payload: { requestId: string }): Promise<void> {
    const req = this.getRequest(payload.requestId);
    if (!req || req.status !== "approved" || !req.acceptorId) return;
    this.notify(
      req.acceptorId,
      `⏰ Reminder: you're covering the ${SHIFT_DEFS[req.shift].label.toLowerCase()} shift tomorrow (${formatDate(req.date)}).`
    );
  }

  // ── UI actions ────────────────────────────────────────────────────

  /** Called when a browser connects: seeds a demo team the first time. */
  @callable()
  async hello(timezone: string): Promise<void> {
    if (this.getSetting("seeded") !== "1") {
      await this.resetDemo(timezone);
      return;
    }
    this.refreshState();
  }

  @callable()
  async resetDemo(timezone?: string): Promise<void> {
    let tz = timezone ?? this.getRules().timezone;
    try {
      assertTimezone(tz);
    } catch {
      tz = "UTC";
    }
    for (const r of this.getRequests(500)) {
      if (OPEN_STATUSES.includes(r.status) && r.workflowId) {
        await this.terminateWorkflow(r.workflowId).catch(() => {});
      }
    }
    for (const s of await this.listSchedules()) {
      if (s.callback === "expireRequest" || s.callback === "shiftReminder") {
        await this.cancelSchedule(s.id);
      }
    }
    seedDemoTeam(this, tz, localDate(Date.now(), tz));
    await this.saveMessages([]).catch(() => {});
    this.refreshState();
  }

  @callable()
  setFlexFromUI(memberId: string, date: string, shifts: WorkShift[]): void {
    if (!this.getMember(memberId)) return;
    this.setFlexAvailability(
      memberId,
      date,
      shifts.filter((s): s is WorkShift => s === "D" || s === "N")
    );
  }

  /** Test hook used by the README walkthrough: fire a reminder now. */
  @callable()
  async previewReminder(requestId: string): Promise<void> {
    await this.shiftReminder({ requestId });
  }

  /** Exposed for tools; keeps findMember usage in one place. */
  member(roster: Roster, id: string) {
    return findMember(roster, id);
  }
}
