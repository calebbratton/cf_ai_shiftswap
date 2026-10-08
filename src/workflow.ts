import { AgentWorkflow, WorkflowRejectedError } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { TeamAgent } from "./team-agent";

type SwapParams = { requestId: string };

/**
 * One instance per swap request:
 *   find candidates -> offer -> wait for a coworker to accept ->
 *   wait for manager approval -> re-check eligibility and apply ->
 *   schedule reminder -> announce.
 *
 * The waits can last hours or days. A Workflow keeps that durable
 * (survives deploys and evictions) with per-step retries, while the
 * TeamAgent stays the single owner of the data: every step is an RPC
 * into the agent, which makes each one idempotent.
 */
export class SwapWorkflow extends AgentWorkflow<TeamAgent, SwapParams> {
  async run(event: AgentWorkflowEvent<SwapParams>, step: AgentWorkflowStep) {
    const { requestId } = event.payload;

    const candidates = await step.do("find-candidates", async () =>
      this.agent.candidatesFor(requestId)
    );
    if (candidates.length === 0) {
      await step.do("close-unfilled", async () =>
        this.agent.closeRequest(
          requestId,
          "unfilled",
          "No eligible coworkers",
          true
        )
      );
      return { outcome: "unfilled" };
    }

    await step.do("offer", async () =>
      this.agent.offerTo(requestId, candidates)
    );

    // The agent's expireRequest schedule ends the request at the real
    // deadline (and terminates this instance); this timeout is a backstop.
    let acceptorId: string;
    try {
      const accepted = await step.waitForEvent<{ memberId: string }>(
        "wait-for-acceptance",
        { type: "accepted", timeout: "49 hours" }
      );
      acceptorId = accepted.payload.memberId;
    } catch {
      await step.do("close-expired", async () =>
        this.agent.closeRequest(requestId, "expired", "No one accepted", true)
      );
      return { outcome: "expired" };
    }

    await step.do("record-acceptance", async () =>
      this.agent.confirmAccepted(requestId, acceptorId)
    );

    try {
      await this.waitForApproval(step, { timeout: "72 hours" });
    } catch (e) {
      const declined = e instanceof WorkflowRejectedError;
      await step.do("close-not-approved", async () =>
        this.agent.closeRequest(
          requestId,
          declined ? "declined" : "expired",
          declined ? "Manager declined" : "Approval timed out",
          true
        )
      );
      return { outcome: declined ? "declined" : "expired" };
    }

    // Race guard: the roster may have changed while the manager decided.
    const applied = await step.do("recheck-and-apply", async () => {
      // Copy out of the RPC result (which is a disposable stub object).
      const r = await this.agent.applySwap(requestId);
      return { ok: r.ok, reason: r.reason };
    });
    if (!applied.ok) {
      await step.do("close-failed", async () =>
        this.agent.closeRequest(
          requestId,
          "failed",
          applied.reason ?? undefined,
          true
        )
      );
      return { outcome: "failed", reason: applied.reason };
    }

    await step.do("schedule-reminder", async () =>
      this.agent.scheduleShiftReminder(requestId)
    );
    await step.do("announce", async () => this.agent.announceSwap(requestId));
    await step.reportComplete({ outcome: "approved" });
    return { outcome: "approved" };
  }
}
