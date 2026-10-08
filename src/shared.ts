/** Types shared by the Worker and the React client. */
import type { WorkShift } from "./rotation";
import type { Member, RosterGrid, TeamRules } from "./swaps";

/** Who the current browser is acting as: a member id, or the manager. */
export type Actor = string;
export const MANAGER = "manager";

export type SwapStatus =
  | "searching"
  | "offered"
  | "accepted"
  | "approved"
  | "declined"
  | "cancelled"
  | "expired"
  | "unfilled"
  | "failed";

export const OPEN_STATUSES: SwapStatus[] = ["searching", "offered", "accepted"];

export type SwapRequest = {
  id: string;
  requesterId: string;
  date: string;
  shift: WorkShift;
  status: SwapStatus;
  /** Member ids the shift was offered to, best match first */
  offeredTo: string[];
  declinedBy: string[];
  acceptorId: string | null;
  note: string | null;
  workflowId: string | null;
  expiresAt: string | null;
  history: { at: string; status: SwapStatus; note?: string }[];
  createdAt: string;
};

export type Notice = {
  id: string;
  /** member id, "manager", or "all" */
  to: string;
  text: string;
  at: string;
};

export type TeamState = {
  seeded: boolean;
  teamName: string;
  today: string;
  rules: TeamRules;
  members: Member[];
  grid: RosterGrid;
  requests: SwapRequest[];
  notices: Notice[];
};
