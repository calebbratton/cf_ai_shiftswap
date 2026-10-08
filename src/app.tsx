import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import type { ShiftCode, WorkShift } from "./rotation";
import { MANAGER, OPEN_STATUSES, type SwapRequest, type TeamState } from "./shared";

// ── Per-browser identity ──────────────────────────────────────────────

function stored(key: string, make: () => string): string {
  try {
    const v = localStorage.getItem(key);
    if (v) return v;
    const fresh = make();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return make();
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: fine, it just won't persist.
  }
}

const TEAM_ID = stored("shiftswap.team", () => `demo-${crypto.randomUUID()}`);
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ── Small helpers ─────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { weekday: WEEKDAYS[wd], day: d, month: m };
}

function shortDate(date: string) {
  const { weekday, day, month } = dayLabel(date);
  return `${weekday} ${month}/${day}`;
}

const SHIFT_NAME: Record<WorkShift, string> = { D: "day", N: "night" };

const STATUS_STYLE: Record<string, string> = {
  searching: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  offered: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  accepted: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        STATUS_STYLE[status] ??
        "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
      }`}
    >
      {status}
    </span>
  );
}

function Btn(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "ghost" | "danger";
  }
) {
  const { tone = "ghost", className = "", ...rest } = props;
  const tones = {
    primary:
      "bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50",
    ghost:
      "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800",
    danger:
      "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
  };
  return (
    <button
      {...rest}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${tones[tone]} ${className}`}
    />
  );
}

// ── Roster grid ───────────────────────────────────────────────────────

const NEXT_FLEX: Record<string, WorkShift[]> = {
  "": ["D"],
  D: ["N"],
  N: ["D", "N"],
  DN: []
};

function Roster({
  state,
  actor,
  onToggleFlex,
  onRequestCover
}: {
  state: TeamState;
  actor: string;
  onToggleFlex: (memberId: string, date: string, shifts: WorkShift[]) => void;
  onRequestCover: (memberId: string, date: string) => void;
}) {
  const { grid, today } = state;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-zinc-50 dark:bg-zinc-900">
            <th className="sticky left-0 z-10 bg-zinc-50 px-2 py-1.5 text-left font-medium dark:bg-zinc-900">
              Team
            </th>
            {grid.dates.map((d, i) => {
              const { weekday, day } = dayLabel(d);
              return (
                <th
                  key={d}
                  className={`min-w-9 px-1 py-1.5 text-center font-medium ${
                    d === today ? "text-orange-600" : "text-zinc-500"
                  } ${i === 7 ? "border-l-2 border-zinc-300 dark:border-zinc-700" : ""}`}
                >
                  <div>{weekday}</div>
                  <div className="text-[10px]">{day}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => {
            const mine = row.memberId === actor;
            return (
              <tr
                key={row.memberId}
                className={`border-t border-zinc-100 dark:border-zinc-800 ${
                  mine ? "bg-orange-50/60 dark:bg-orange-950/20" : ""
                }`}
              >
                <td
                  className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1 ${
                    mine
                      ? "bg-orange-50 dark:bg-zinc-900"
                      : "bg-white dark:bg-zinc-950"
                  }`}
                  title={row.pattern}
                >
                  <span className="font-medium">{row.name.split(" ")[0]}</span>{" "}
                  <span className="text-zinc-400">{row.role}</span>
                </td>
                {row.shifts.map((s: ShiftCode, i) => {
                  const date = grid.dates[i];
                  const flex = row.flex[i];
                  const canToggle = mine && s === "-" && date >= today;
                  const canRequest = mine && s !== "-" && date >= today;
                  const key = flex.join("");
                  return (
                    <td
                      key={date}
                      className={`p-0.5 text-center ${
                        i === 7 ? "border-l-2 border-zinc-300 dark:border-zinc-700" : ""
                      }`}
                    >
                      <button
                        type="button"
                        disabled={!canToggle && !canRequest}
                        onClick={() =>
                          canRequest
                            ? onRequestCover(row.memberId, date)
                            : onToggleFlex(row.memberId, date, NEXT_FLEX[key] ?? [])
                        }
                        title={
                          s !== "-"
                            ? `${SHIFT_NAME[s]} shift${row.swapped[i] ? " (swapped)" : ""}${canRequest ? ": click to ask coworkers to cover it" : ""}`
                            : flex.length
                              ? `flex: would pick up ${flex.map((f) => SHIFT_NAME[f]).join(" or ")}`
                              : canToggle
                                ? "off: click to mark flex availability"
                                : "off"
                        }
                        className={`h-7 w-full rounded text-[11px] font-semibold ${
                          s === "D"
                            ? "bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-100"
                            : s === "N"
                              ? "bg-indigo-300 text-indigo-950 dark:bg-indigo-500/40 dark:text-indigo-100"
                              : flex.length
                                ? "border border-dashed border-emerald-500 text-emerald-700 dark:text-emerald-300"
                                : "text-zinc-300 dark:text-zinc-700"
                        } ${row.swapped[i] ? "ring-2 ring-orange-500" : ""} ${
                          canToggle ? "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800" : canRequest ? "cursor-pointer hover:opacity-80" : ""
                        }`}
                      >
                        {s !== "-" ? s : flex.length ? `+${flex.join("")}` : "·"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────

function Inbox({
  state,
  actor,
  call
}: {
  state: TeamState;
  actor: string;
  call: (fn: string, ...args: unknown[]) => Promise<void>;
}) {
  const name = (id: string | null) =>
    id === MANAGER
      ? "Manager"
      : (state.members.find((m) => m.id === id)?.name ?? "?");
  const what = (r: SwapRequest) =>
    `${name(r.requesterId).split(" ")[0]}'s ${SHIFT_NAME[r.shift]} shift, ${shortDate(r.date)}`;

  const isManager = actor === MANAGER;
  const offers = state.requests.filter(
    (r) =>
      r.status === "offered" &&
      r.offeredTo.includes(actor) &&
      !r.declinedBy.includes(actor)
  );
  const approvals = state.requests.filter((r) => r.status === "accepted");
  const mine = state.requests.filter((r) =>
    isManager ? true : r.requesterId === actor || r.acceptorId === actor
  );
  const notices = state.notices.filter(
    (n) => n.to === actor || n.to === "all"
  );

  return (
    <div className="space-y-3 text-sm">
      {isManager && (
        <Section title="Needs your approval" empty="Nothing waiting.">
          {approvals.map((r) => (
            <Item key={r.id}>
              <div>
                <b>{name(r.acceptorId)}</b> will cover {what(r)}
              </div>
              <div className="mt-1.5 flex gap-2">
                <Btn tone="primary" onClick={() => call("approveSwap", r.id)}>
                  Approve
                </Btn>
                <Btn tone="danger" onClick={() => call("rejectSwap", r.id)}>
                  Decline
                </Btn>
              </div>
            </Item>
          ))}
        </Section>
      )}

      {!isManager && (
        <Section title="Shifts offered to you" empty="No open offers.">
          {offers.map((r) => (
            <Item key={r.id}>
              <div>
                Can you take <b>{what(r)}</b>?
                {r.note && <div className="text-xs text-zinc-500">"{r.note}"</div>}
              </div>
              <div className="mt-1.5 flex gap-2">
                <Btn tone="primary" onClick={() => call("acceptOffer", r.id, actor)}>
                  Accept
                </Btn>
                <Btn onClick={() => call("declineOffer", r.id, actor)}>Decline</Btn>
              </div>
            </Item>
          ))}
        </Section>
      )}

      <Section
        title={isManager ? "All requests" : "Your requests"}
        empty="None yet. Ask in the chat."
      >
        {mine.slice(0, 8).map((r) => (
          <Item key={r.id}>
            <div className="flex items-center justify-between gap-2">
              <span>
                {what(r)}
                {r.acceptorId && (
                  <span className="text-zinc-500"> → {name(r.acceptorId).split(" ")[0]}</span>
                )}
              </span>
              <StatusPill status={r.status} />
            </div>
            {r.status === "offered" && (
              <div className="mt-1 text-xs text-zinc-500">
                Offered to {r.offeredTo.map((id) => name(id).split(" ")[0]).join(", ")}
                {r.declinedBy.length > 0 &&
                  ` · declined: ${r.declinedBy.map((id) => name(id).split(" ")[0]).join(", ")}`}
              </div>
            )}
            {OPEN_STATUSES.includes(r.status) &&
              (isManager || r.requesterId === actor) && (
                <Btn
                  className="mt-1.5"
                  onClick={() => call("cancelRequestFromUI", r.id, actor)}
                >
                  Cancel request
                </Btn>
              )}
          </Item>
        ))}
      </Section>

      <Section title="Notifications" empty="Nothing new.">
        {notices.slice(0, 6).map((n) => (
          <Item key={n.id}>
            <div className="text-xs">{n.text}</div>
          </Item>
        ))}
      </Section>
    </div>
  );
}

function Section(props: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
        {props.title}
      </h3>
      {props.children.length ? (
        <div className="space-y-1.5">{props.children}</div>
      ) : (
        <p className="text-xs text-zinc-400">{props.empty}</p>
      )}
    </div>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      {children}
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────────

function ChatMessage({ message, nameOf }: { message: UIMessage; nameOf: (id: string) => string }) {
  const isUser = message.role === "user";
  const speaker = isUser
    ? nameOf((message.metadata as { actorId?: string } | undefined)?.actorId ?? MANAGER)
    : "Assistant";
  const texts = message.parts.filter((p) => p.type === "text");
  const tools = message.parts.filter(isToolUIPart);
  if (texts.length === 0 && tools.length === 0) return null;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[88%]">
        <div className={`mb-0.5 text-[11px] text-zinc-400 ${isUser ? "text-right" : ""}`}>
          {speaker}
        </div>
        {tools.map((t) => (
          <div
            key={t.toolCallId}
            className="mb-1 inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800"
          >
            ⚙ {getToolName(t)}
            {t.state === "output-available" ? " ✓" : t.state === "output-error" ? " ✕" : " …"}
          </div>
        ))}
        {texts.map((p, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm ${
              isUser
                ? "bg-orange-600 text-white"
                : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            }`}
          >
            {isUser ? p.text : <Streamdown>{p.text}</Streamdown>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────

export default function App() {
  const [actor, setActorRaw] = useState(() => stored("shiftswap.actor", () => "alex"));
  const setActor = (a: string) => {
    setActorRaw(a);
    remember("shiftswap.actor", a);
  };
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "inbox">("chat");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<TeamState>({
    agent: "TeamAgent",
    name: TEAM_ID,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });
  const state = agent.state;

  useEffect(() => {
    if (connected) agent.call("hello", [BROWSER_TZ]).catch(console.error);
  }, [connected, agent]);

  const { messages, sendMessage, status, stop, clearHistory } = useAgentChat({
    agent
  });
  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const call = useCallback(
    async (fn: string, ...args: unknown[]) => {
      setError(null);
      try {
        const r = (await agent.call(fn, args)) as { ok?: boolean; error?: string } | undefined;
        if (r && r.ok === false && r.error) setError(r.error);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [agent]
  );

  const members = state?.members ?? [];
  const nameOf = (id: string) =>
    id === MANAGER ? "Manager" : (members.find((m) => m.id === id)?.name ?? id);
  const me = members.find((m) => m.id === actor);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({
      role: "user",
      parts: [{ type: "text", text }],
      metadata: { actorId: actor }
    });
    setInput("");
  };

  const suggestions = useMemo(
    () =>
      actor === MANAGER
        ? ["Who's working this Friday?", "Who could cover Alex's Friday shift?", "Show open swap requests"]
        : [
            "Can you find someone to trade shifts with me this Friday?",
            "I can pick up day shifts next Monday and Tuesday",
            "What are my shifts this week?"
          ],
    [actor]
  );

  const inboxCount = state
    ? actor === MANAGER
      ? state.requests.filter((r) => r.status === "accepted").length
      : state.requests.filter(
          (r) => r.status === "offered" && r.offeredTo.includes(actor) && !r.declinedBy.includes(actor)
        ).length
    : 0;

  return (
    <div className="flex h-full flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="mr-auto">
          <h1 className="text-base font-semibold">
            Shift Swap <span className="text-orange-600">AI</span>
          </h1>
          <p className="text-xs text-zinc-500">
            {state?.teamName || "Loading team…"}
            {state?.rules && ` · ${state.rules.timezone}`}
            <span className={`ml-2 inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-400"}`} />
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Acting as</span>
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.role})
              </option>
            ))}
            <option value={MANAGER}>Manager</option>
          </select>
        </label>
        <Btn
          onClick={async () => {
            await call("resetDemo", BROWSER_TZ);
            clearHistory();
          }}
        >
          Reset demo
        </Btn>
      </header>

      {error && (
        <div className="flex items-center justify-between bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <section className="p-4 lg:min-h-0 lg:overflow-y-auto">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Roster · this week and next</h2>
            <div className="flex flex-wrap gap-3 text-[11px] text-zinc-500">
              <span><b className="text-amber-700">D</b> day 7a-7p</span>
              <span><b className="text-indigo-700">N</b> night 7p-7a</span>
              <span><b className="text-emerald-600">+D</b> flex</span>
              <span className="rounded px-1 ring-2 ring-orange-500">swapped</span>
            </div>
          </div>
          {state?.grid.rows.length ? (
            <Roster
              state={state}
              actor={actor}
              onToggleFlex={(m, d, s) => call("setFlexFromUI", m, d, s)}
              onRequestCover={(m, d) => {
                if (confirm(`Ask coworkers to cover your ${shortDate(d)} shift?`)) {
                  void call("requestSwapFromUI", m, d);
                }
              }}
            />
          ) : (
            <p className="text-sm text-zinc-500">Setting up the demo team…</p>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            {me
              ? `You're ${me.name.split(" ")[0]} (${me.role}). Click one of your days off to mark flex availability (swaps go to flex-marked coworkers first), or one of your shifts to ask for cover.`
              : "As manager you approve swaps that a coworker has accepted. Switch “Acting as” to play each person."}
          </p>

          <div className="mt-5 hidden lg:block">
            {state && <Inbox state={state} actor={actor} call={call} />}
          </div>
        </section>

        <section className="flex h-[80vh] flex-col border-t border-zinc-200 lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l dark:border-zinc-800">
          <div className="flex border-b border-zinc-200 text-sm lg:hidden dark:border-zinc-800">
            {(["chat", "inbox"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 capitalize ${tab === t ? "border-b-2 border-orange-600 font-semibold" : "text-zinc-500"}`}
              >
                {t}
                {t === "inbox" && inboxCount > 0 && ` (${inboxCount})`}
              </button>
            ))}
          </div>

          {tab === "inbox" && (
            <div className="overflow-y-auto p-4 lg:hidden">
              {state && <Inbox state={state} actor={actor} call={call} />}
            </div>
          )}

          <div className={`min-h-0 flex-1 flex-col ${tab === "chat" ? "flex" : "hidden lg:flex"}`}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && (
                <div className="space-y-2 pt-4 text-center">
                  <p className="text-sm text-zinc-500">
                    Team channel. Ask the assistant as {nameOf(actor).split(" ")[0]}:
                  </p>
                  <div className="flex flex-col items-center gap-1.5">
                    {suggestions.map((s) => (
                      <Btn key={s} onClick={() => send(s)} disabled={busy}>
                        {s}
                      </Btn>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m) => (
                <ChatMessage key={m.id} message={m} nameOf={nameOf} />
              ))}
              {status === "submitted" && <p className="text-xs text-zinc-400">Thinking…</p>}
              <div ref={endRef} />
            </div>
            <form
              className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message as ${nameOf(actor).split(" ")[0]}…`}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              {busy ? (
                <Btn type="button" onClick={stop}>Stop</Btn>
              ) : (
                <Btn type="submit" tone="primary" disabled={!input.trim()}>
                  Send
                </Btn>
              )}
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
