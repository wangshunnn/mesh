import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { RoomSnapshot } from "@ai-mesh/workspace";
import { CoreAction, type RoomEvent, type SubjectRef, type TaskStatus } from "@ai-mesh/protocol";

import type { DesktopAgentProbe } from "../shared/api.js";

const emptySnapshot: RoomSnapshot = Object.freeze({
  roomId: "room:loading",
  headSequence: 0,
  agents: Object.freeze([]),
  messages: Object.freeze([]),
  tasks: Object.freeze([]),
  timeline: Object.freeze([]),
});

const previewSnapshot: RoomSnapshot = Object.freeze({
  roomId: "room:phase-1-preview",
  headSequence: 9,
  agents: Object.freeze([
    Object.freeze({
      id: "agent:opencode",
      name: "OpenCode",
      handle: "opencode",
      adapterKind: "opencode",
      state: "waiting",
      sessionId: "preview-acp",
      updatedAt: Date.now(),
    }),
    Object.freeze({
      id: "agent:codex",
      name: "Codex",
      handle: "codex",
      adapterKind: "codex",
      state: "idle",
      sessionId: "preview-native",
      updatedAt: Date.now(),
    }),
  ]),
  messages: Object.freeze([
    Object.freeze({
      eventId: "preview:message:1",
      sequence: 3,
      threadId: "general",
      from: "human",
      text: "@opencode map the authentication flow and hand your findings to @codex.",
      attention: Object.freeze(["agent:opencode"]),
      respondingTo: Object.freeze([]),
      createdAt: Date.now() - 120_000,
    }),
    Object.freeze({
      eventId: "preview:message:2",
      sequence: 5,
      threadId: "general",
      from: "agent:opencode",
      text: "The refresh-token path crosses session.ts and token-store.ts. @codex please verify the two callers.",
      attention: Object.freeze(["agent:codex"]),
      respondingTo: Object.freeze(["preview:message:1"]),
      createdAt: Date.now() - 70_000,
    }),
    Object.freeze({
      eventId: "preview:message:3",
      sequence: 8,
      threadId: "general",
      from: "agent:codex",
      text: "Verified both call sites and recorded the follow-up task. @human the handoff is complete.",
      attention: Object.freeze(["human"]),
      respondingTo: Object.freeze(["preview:message:2"]),
      createdAt: Date.now() - 25_000,
    }),
  ]),
  tasks: Object.freeze([
    Object.freeze({
      id: "preview-task",
      title: "Harden refresh-token rotation",
      status: "review",
      ownerId: "agent:codex",
      version: 3,
      updatedAt: Date.now() - 20_000,
    }),
  ]),
  timeline: Object.freeze([
    previewEvent(
      3,
      "human",
      { kind: "thread", id: "general" },
      CoreAction.threadMessageAppend,
      { kind: "message", text: "Authentication review requested" },
      Date.now() - 120_000,
    ),
    previewEvent(
      5,
      "agent:opencode",
      { kind: "thread", id: "general" },
      CoreAction.threadReplyCommit,
      { kind: "message", text: "Findings handed to Codex" },
      Date.now() - 70_000,
    ),
    previewEvent(
      7,
      "agent:codex",
      { kind: "task", id: "preview-task" },
      CoreAction.taskClaim,
      { kind: "task-claimed", ownerId: "agent:codex" },
      Date.now() - 38_000,
    ),
    previewEvent(
      8,
      "agent:codex",
      { kind: "thread", id: "general" },
      CoreAction.threadReplyCommit,
      { kind: "message", text: "Verification returned to human" },
      Date.now() - 25_000,
    ),
    previewEvent(
      9,
      "agent:codex",
      { kind: "task", id: "preview-task" },
      CoreAction.taskUpdate,
      { kind: "task-updated", status: "review" },
      Date.now() - 20_000,
    ),
  ]),
});

type RightPanel = "tasks" | "activity";

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);
  const [probes, setProbes] = useState<readonly DesktopAgentProbe[]>([]);
  const [panel, setPanel] = useState<RightPanel>("tasks");
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    if (window.mesh === undefined) {
      setSnapshot(previewSnapshot);
      setProbes([
        { id: "agent:opencode", available: true, version: "1.18.16" },
        { id: "agent:codex", available: true, version: "0.146.0" },
      ]);
      return () => {
        live = false;
      };
    }
    void Promise.all([window.mesh.snapshot(), window.mesh.probeAgents()])
      .then(([initial, availability]) => {
        if (live) {
          setSnapshot(initial);
          setProbes(availability);
        }
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
    const unsubscribe = window.mesh.onSnapshot((next) => {
      if (live) {
        setSnapshot(next);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [snapshot.messages.length]);

  const invoke = async (key: string, operation: () => Promise<RoomSnapshot>): Promise<void> => {
    setBusy(key);
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("Preview mode is read-only. Open the Electron app for live room actions.");
      }
      setSnapshot(await operation());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <main className="shell">
      <Header snapshot={snapshot} busy={busy} invoke={invoke} />
      {error === undefined ? null : (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      )}
      <div className="workspace-grid">
        <AgentRail snapshot={snapshot} probes={probes} busy={busy} invoke={invoke} />
        <section className="chat-column">
          <div className="section-heading chat-heading">
            <div>
              <p className="eyebrow">Shared room</p>
              <h1>Team chat</h1>
            </div>
            <span className="shared-state"><i /> One replayable reality</span>
          </div>
          <MessageList snapshot={snapshot} chatEnd={chatEnd} />
          <Composer snapshot={snapshot} busy={busy} invoke={invoke} />
        </section>
        <aside className="right-column">
          <div className="panel-tabs" role="tablist">
            <button
              type="button"
              className={panel === "tasks" ? "active" : ""}
              onClick={() => setPanel("tasks")}
            >
              Tasks <span>{snapshot.tasks.length}</span>
            </button>
            <button
              type="button"
              className={panel === "activity" ? "active" : ""}
              onClick={() => setPanel("activity")}
            >
              Activity <span>{snapshot.timeline.length}</span>
            </button>
          </div>
          {panel === "tasks" ? (
            <TaskPanel snapshot={snapshot} busy={busy} invoke={invoke} />
          ) : (
            <ActivityPanel snapshot={snapshot} />
          )}
        </aside>
      </div>
    </main>
  );
}

interface RuntimeProps {
  readonly snapshot: RoomSnapshot;
  readonly busy: string | undefined;
  readonly invoke: (key: string, operation: () => Promise<RoomSnapshot>) => Promise<void>;
}

function Header({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div><strong>Mesh</strong><small>agent team workspace</small></div>
      </div>
      <div className="room-meta">
        <span className="local-pill">LOCAL</span>
        <span>{snapshot.roomId}</span>
        <span className="sequence">HEAD {snapshot.headSequence}</span>
      </div>
      <button
        type="button"
        className="primary compact"
        disabled={busy !== undefined}
        onClick={() => void invoke("start-all", () => window.mesh.startAvailableAgents())}
      >
        {busy === "start-all" ? "Starting…" : "Start available agents"}
      </button>
    </header>
  );
}

interface AgentRailProps extends RuntimeProps {
  readonly probes: readonly DesktopAgentProbe[];
}

function AgentRail({ snapshot, probes, busy, invoke }: AgentRailProps): React.JSX.Element {
  const availability = useMemo(() => new Map(probes.map((probe) => [probe.id, probe])), [probes]);
  return (
    <aside className="agent-rail">
      <div className="section-heading">
        <div><p className="eyebrow">Participants</p><h2>Agents</h2></div>
        <span className="count-badge">{snapshot.agents.length}</span>
      </div>
      <div className="agent-list">
        {snapshot.agents.map((agent) => {
          const probe = availability.get(agent.id);
          const running = agent.state !== "offline" && agent.state !== "error";
          const action = running ? "stop" : "start";
          const key = `${action}:${agent.id}`;
          return (
            <article className="agent-card" key={agent.id}>
              <div className="agent-card-top">
                <div className={`avatar avatar-${agent.handle.slice(0, 1)}`}>{agent.name.slice(0, 1)}</div>
                <div className="agent-identity">
                  <strong>{agent.name}</strong>
                  <span>@{agent.handle}</span>
                </div>
                <i className={`status-dot ${agent.state}`} title={agent.state} />
              </div>
              <div className="agent-facts">
                <span>{agent.adapterKind}</span>
                <span>{probe?.available === false ? "not found" : probe?.version ?? "probing"}</span>
              </div>
              <div className="agent-card-bottom">
                <span className={`status-label ${agent.state}`}>{agent.state}</span>
                <button
                  type="button"
                  className="ghost compact"
                  disabled={busy !== undefined || probe?.available === false}
                  onClick={() => void invoke(key, () => window.mesh.agentAction({ agentId: agent.id, action }))}
                >
                  {busy === key ? "…" : running ? "Stop" : "Start"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="rail-note">
        <strong>Shared state, independent minds.</strong>
        <p>@mentions wake an agent. They never hide information from the rest of the room.</p>
      </div>
    </aside>
  );
}

function MessageList({
  snapshot,
  chatEnd,
}: {
  readonly snapshot: RoomSnapshot;
  readonly chatEnd: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  if (snapshot.messages.length === 0) {
    return (
      <div className="message-list empty-state">
        <div className="empty-orbit"><span /><span /><span /></div>
        <h3>Bring the room to life</h3>
        <p>Address an agent with @handle, or send to the whole team. Every message becomes durable shared context.</p>
        <div ref={chatEnd} />
      </div>
    );
  }
  return (
    <div className="message-list">
      {snapshot.messages.map((message) => {
        const own = message.from === "human";
        return (
          <article className={`message ${own ? "human" : "agent"}`} key={message.eventId}>
            <div className="message-avatar">{participantInitial(message.from)}</div>
            <div className="message-body">
              <div className="message-meta">
                <strong>{participantLabel(snapshot, message.from)}</strong>
                <span>#{message.sequence}</span>
                <time>{formatClock(message.createdAt)}</time>
              </div>
              <p>{renderMentions(message.text)}</p>
              <div className="attention-row">
                <span>attention</span>
                {message.attention === "team" ? (
                  <b>@team</b>
                ) : message.attention.map((participant) => <b key={participant}>{participantLabel(snapshot, participant)}</b>)}
              </div>
            </div>
          </article>
        );
      })}
      <div ref={chatEnd} />
    </div>
  );
}

function Composer({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [to, setTo] = useState("auto");
  const send = (event: FormEvent): void => {
    event.preventDefault();
    const message = text.trim();
    if (message.length === 0 || busy !== undefined) {
      return;
    }
    void invoke("send", () => window.mesh.postMessage({
      text: message,
      ...(to === "auto" ? {} : { to }),
    })).then(() => setText(""));
  };
  return (
    <form className="composer" onSubmit={send}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Message the room… Try @codex or @opencode"
        rows={3}
      />
      <div className="composer-actions">
        <label>
          <span>Attention</span>
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="auto">Detect mentions</option>
            <option value="team">@team</option>
            {snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.handle}</option>)}
          </select>
        </label>
        <span className="composer-hint">Enter to send · Shift+Enter for newline</span>
        <button className="primary" type="submit" disabled={busy !== undefined || text.trim().length === 0}>
          {busy === "send" ? "Sending…" : "Send to room"}
        </button>
      </div>
    </form>
  );
}

function TaskPanel({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
  const [title, setTitle] = useState("");
  const create = (event: FormEvent): void => {
    event.preventDefault();
    const next = title.trim();
    if (next.length === 0) return;
    void invoke("task:create", () => window.mesh.createTask({ title: next })).then(() => setTitle(""));
  };
  return (
    <div className="panel-content task-panel">
      <form className="quick-task" onSubmit={create}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New shared task" />
        <button type="submit" className="primary square" disabled={busy !== undefined || title.trim().length === 0}>+</button>
      </form>
      {snapshot.tasks.length === 0 ? (
        <div className="small-empty"><strong>No tasks yet</strong><p>Create one and let any agent claim it atomically.</p></div>
      ) : (
        <div className="task-list">
          {snapshot.tasks.map((task) => (
            <article className="task-card" key={task.id}>
              <div className="task-title"><i className={`task-state ${task.status}`} /><strong>{task.title}</strong></div>
              <p>{task.description ?? `Task ${task.id.slice(0, 8)}`}</p>
              <div className="task-controls">
                <select
                  value={task.status}
                  disabled={busy !== undefined}
                  onChange={(event) => void invoke(`task:update:${task.id}`, () => window.mesh.updateTask({
                    taskId: task.id,
                    status: event.target.value as TaskStatus,
                  }))}
                >
                  <option value="todo">Todo</option>
                  <option value="in_progress">In progress</option>
                  <option value="blocked">Blocked</option>
                  <option value="review">Review</option>
                  <option value="done">Done</option>
                </select>
                {task.ownerId === undefined ? (
                  <select
                    value=""
                    disabled={busy !== undefined}
                    onChange={(event) => {
                      if (event.target.value.length > 0) {
                        void invoke(`task:claim:${task.id}`, () => window.mesh.claimTask({
                          taskId: task.id,
                          ownerId: event.target.value,
                        }));
                      }
                    }}
                  >
                    <option value="">Claim for…</option>
                    {snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.handle}</option>)}
                  </select>
                ) : <span className="owner-chip">{participantLabel(snapshot, task.ownerId)}</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityPanel({ snapshot }: { readonly snapshot: RoomSnapshot }): React.JSX.Element {
  return (
    <div className="panel-content activity-panel">
      {snapshot.timeline.length === 0 ? (
        <div className="small-empty"><strong>No activity yet</strong><p>Every committed room fact will appear here.</p></div>
      ) : (
        snapshot.timeline.slice().reverse().map((event) => (
          <article className="activity-item" key={event.id}>
            <span className="activity-sequence">{event.sequence}</span>
            <div>
              <strong>{activityLabel(event.action)}</strong>
              <p>{event.actorId} · {event.subject.kind}:{event.subject.id}</p>
              <time>{formatClock(event.committedAt)}</time>
            </div>
          </article>
        ))
      )}
    </div>
  );
}

function participantLabel(snapshot: RoomSnapshot, id: string): string {
  if (id === "human") return "@human";
  const agent = snapshot.agents.find((candidate) => candidate.id === id);
  return agent === undefined ? id : `@${agent.handle}`;
}

function participantInitial(id: string): string {
  return id === "human" ? "H" : id.split(":").at(-1)?.slice(0, 1).toUpperCase() ?? "A";
}

function renderMentions(text: string): React.ReactNode {
  return text.split(/(@[A-Za-z0-9][A-Za-z0-9:._-]*[A-Za-z0-9_-]?)/g).map((part, index) =>
    part.startsWith("@") ? <mark key={`${part}-${index}`}>{part}</mark> : part,
  );
}

function activityLabel(action: string): string {
  return action.split(".").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" · ");
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewEvent(
  sequence: number,
  actorId: string,
  subject: SubjectRef,
  action: string,
  payload: unknown,
  committedAt: number,
): RoomEvent {
  return Object.freeze({
    id: `preview:event:${String(sequence)}`,
    sequence,
    roomId: "room:phase-1-preview",
    actorId,
    subject: Object.freeze({ ...subject }),
    subjectVersion: 1,
    action,
    payload: Object.freeze(payload as object),
    intentId: `preview:intent:${String(sequence)}`,
    idempotencyKey: `preview:key:${String(sequence)}`,
    causedBy: Object.freeze([]),
    committedAt,
  });
}
