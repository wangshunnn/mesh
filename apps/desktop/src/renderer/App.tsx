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
  roomId: "room:mesh-preview",
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
      text: "@opencode 请梳理登录认证流程，并把结论交接给 @codex。",
      attention: Object.freeze(["agent:opencode"]),
      respondingTo: Object.freeze([]),
      createdAt: Date.now() - 120_000,
    }),
    Object.freeze({
      eventId: "preview:message:2",
      sequence: 5,
      threadId: "general",
      from: "agent:opencode",
      text: "刷新令牌路径会经过 session.ts 和 token-store.ts。@codex 请核对这两处调用方。",
      attention: Object.freeze(["agent:codex"]),
      respondingTo: Object.freeze(["preview:message:1"]),
      createdAt: Date.now() - 70_000,
    }),
    Object.freeze({
      eventId: "preview:message:3",
      sequence: 8,
      threadId: "general",
      from: "agent:codex",
      text: "已核对两处调用，并记录了后续任务。@human，交接完成。",
      attention: Object.freeze(["human"]),
      respondingTo: Object.freeze(["preview:message:2"]),
      createdAt: Date.now() - 25_000,
    }),
  ]),
  tasks: Object.freeze([
    Object.freeze({
      id: "preview-task",
      title: "加固刷新令牌轮换逻辑",
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
      { kind: "message", text: "已发起认证流程检查" },
      Date.now() - 120_000,
    ),
    previewEvent(
      5,
      "agent:opencode",
      { kind: "thread", id: "general" },
      CoreAction.threadReplyCommit,
      { kind: "message", text: "结论已交接给 Codex" },
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
      { kind: "message", text: "核对结果已返回给用户" },
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

  const invoke = async (key: string, operation: () => Promise<RoomSnapshot>): Promise<boolean> => {
    setBusy(key);
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式仅供查看，请打开 Electron 应用执行房间操作。");
      }
      setSnapshot(await operation());
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
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
          <button type="button" onClick={() => setError(undefined)}>关闭</button>
        </div>
      )}
      <div className="workspace-grid">
        <AgentRail snapshot={snapshot} probes={probes} busy={busy} invoke={invoke} />
        <section className="chat-column">
          <div className="section-heading chat-heading">
            <div>
              <div className="room-title-row">
                <h1>协作房间</h1>
                <span className="shared-state"><i /> 已同步</span>
              </div>
              <p className="room-description">所有成员共享同一份实时上下文</p>
            </div>
            <div className="room-head" title={`当前事件序号 ${String(snapshot.headSequence)}`}>
              <span>HEAD</span>
              <strong>{snapshot.headSequence}</strong>
            </div>
          </div>
          <MessageList snapshot={snapshot} chatEnd={chatEnd} />
          <Composer snapshot={snapshot} busy={busy} invoke={invoke} />
        </section>
        <aside className="right-column">
          <div className="panel-tabs" role="tablist">
            <button
              type="button"
              className={panel === "tasks" ? "active" : ""}
              aria-selected={panel === "tasks"}
              onClick={() => setPanel("tasks")}
            >
              任务 <span>{snapshot.tasks.length}</span>
            </button>
            <button
              type="button"
              className={panel === "activity" ? "active" : ""}
              aria-selected={panel === "activity"}
              onClick={() => setPanel("activity")}
            >
              动态 <span>{snapshot.timeline.length}</span>
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
  readonly invoke: (key: string, operation: () => Promise<RoomSnapshot>) => Promise<boolean>;
}

function Header({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">M</div>
        <strong>Mesh</strong>
      </div>
      <nav className="breadcrumb" aria-label="当前位置">
        <span>本地工作区</span>
        <i>/</i>
        <strong>协作房间</strong>
      </nav>
      <div className="topbar-actions">
        <span className="room-id" title={snapshot.roomId}>{snapshot.roomId}</span>
        <span className="local-pill"><i /> 本地</span>
        <button
          type="button"
          className="primary compact"
          disabled={busy !== undefined}
          onClick={() => void invoke("start-all", () => window.mesh.startAvailableAgents())}
        >
          {busy === "start-all" ? "正在启动…" : "启动可用 Agent"}
        </button>
      </div>
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
        <h2>成员</h2>
        <span className="count-badge">{snapshot.agents.length + 1}</span>
      </div>
      <div className="agent-list">
        <article className="agent-card human-card">
          <div className="agent-card-top">
            <div className="avatar human-avatar">你</div>
            <div className="agent-identity">
              <strong>你</strong>
              <span>@human</span>
            </div>
            <i className="status-dot idle" title="在线" />
          </div>
          <div className="human-presence">当前用户 · 在线</div>
        </article>
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
                <i className={`status-dot ${agent.state}`} title={presenceLabel(agent.state)} />
              </div>
              <div className="agent-facts">
                <span>{agent.adapterKind}</span>
                <span>{probe?.available === false ? "未检测到" : probe?.version ?? "检测中"}</span>
              </div>
              <div className="agent-card-bottom">
                <span className={`status-label ${agent.state}`}>{presenceLabel(agent.state)}</span>
                <button
                  type="button"
                  className="ghost compact"
                  disabled={busy !== undefined || probe?.available === false}
                  onClick={() => void invoke(key, () => window.mesh.agentAction({ agentId: agent.id, action }))}
                >
                  {busy === key ? "…" : running ? "停止" : "启动"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="rail-note">
        <i aria-hidden="true" />
        <div>
          <strong>共享上下文</strong>
          <p>房间消息对所有成员可见，@提及只决定谁需要响应。</p>
        </div>
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
        <div className="empty-mark" aria-hidden="true">M</div>
        <h3>从一条消息开始</h3>
        <p>输入 @handle 指定需要响应的 Agent，或直接发送给全体。每条消息都会成为房间的共享上下文。</p>
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
                <strong>{participantName(snapshot, message.from)}</strong>
                <span>{participantLabel(snapshot, message.from)}</span>
                <time>{formatClock(message.createdAt)}</time>
                <span className="message-sequence">#{message.sequence}</span>
              </div>
              <p>{renderMentions(message.text)}</p>
              <div className="attention-row">
                <span>关注</span>
                {message.attention === "team" ? (
                  <b>@全体成员</b>
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
    })).then((committed) => {
      if (committed) setText("");
    });
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
        placeholder="发送消息给房间，输入 @ 提及 Agent"
        rows={3}
      />
      <div className="composer-actions">
        <label>
          <span>关注</span>
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="auto">自动识别提及</option>
            <option value="team">@全体成员</option>
            {snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.handle}</option>)}
          </select>
        </label>
        <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
        <button className="primary" type="submit" disabled={busy !== undefined || text.trim().length === 0}>
          {busy === "send" ? "发送中…" : "发送"}
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
    void invoke("task:create", () => window.mesh.createTask({ title: next })).then((committed) => {
      if (committed) setTitle("");
    });
  };
  return (
    <div className="panel-content task-panel" role="tabpanel" aria-label="任务">
      <form className="quick-task" onSubmit={create}>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新建共享任务"
          aria-label="任务标题"
        />
        <button
          type="submit"
          className="primary square"
          aria-label="创建任务"
          disabled={busy !== undefined || title.trim().length === 0}
        >+</button>
      </form>
      {snapshot.tasks.length === 0 ? (
        <div className="small-empty"><strong>还没有任务</strong><p>新建任务后，任意 Agent 都可以原子领取。</p></div>
      ) : (
        <div className="task-list">
          {snapshot.tasks.map((task) => (
            <article className="task-card" key={task.id}>
              <div className="task-title"><i className={`task-state ${task.status}`} /><strong>{task.title}</strong></div>
              <p>{task.description ?? `任务 ID · ${task.id.slice(0, 8)}`}</p>
              <div className="task-controls">
                <select
                  value={task.status}
                  disabled={busy !== undefined}
                  onChange={(event) => void invoke(`task:update:${task.id}`, () => window.mesh.updateTask({
                    taskId: task.id,
                    status: event.target.value as TaskStatus,
                  }))}
                >
                  <option value="todo">待处理</option>
                  <option value="in_progress">进行中</option>
                  <option value="blocked">已阻塞</option>
                  <option value="review">待评审</option>
                  <option value="done">已完成</option>
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
                    <option value="">分配给…</option>
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
    <div className="panel-content activity-panel" role="tabpanel" aria-label="动态">
      {snapshot.timeline.length === 0 ? (
        <div className="small-empty"><strong>还没有动态</strong><p>房间中每个已提交事实都会记录在这里。</p></div>
      ) : (
        snapshot.timeline.slice().reverse().map((event) => (
          <article className="activity-item" key={event.id}>
            <span className="activity-sequence">{event.sequence}</span>
            <div>
              <strong>{activityLabel(event.action)}</strong>
              <p>{participantLabel(snapshot, event.actorId)} · {subjectKindLabel(event.subject.kind)} {event.subject.id}</p>
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

function participantName(snapshot: RoomSnapshot, id: string): string {
  if (id === "human") return "你";
  return snapshot.agents.find((candidate) => candidate.id === id)?.name ?? id;
}

function participantInitial(id: string): string {
  return id === "human" ? "你" : id.split(":").at(-1)?.slice(0, 1).toUpperCase() ?? "A";
}

function renderMentions(text: string): React.ReactNode {
  return text.split(/(@[A-Za-z0-9][A-Za-z0-9:._-]*[A-Za-z0-9_-]?)/g).map((part, index) =>
    part.startsWith("@") ? <mark key={`${part}-${index}`}>{part}</mark> : part,
  );
}

function activityLabel(action: string): string {
  switch (action) {
    case CoreAction.threadMessageAppend:
      return "发送了消息";
    case CoreAction.threadReplyCommit:
      return "提交了回复";
    case CoreAction.participantPresenceSet:
      return "更新了在线状态";
    case CoreAction.agentTurnComplete:
      return "完成了一轮工作";
    case CoreAction.taskCreate:
      return "创建了任务";
    case CoreAction.taskClaim:
      return "领取了任务";
    case CoreAction.taskUpdate:
      return "更新了任务";
    case CoreAction.decisionPropose:
      return "提出了决策";
    case CoreAction.artifactPublish:
      return "发布了产物";
    default:
      return action;
  }
}

function subjectKindLabel(kind: SubjectRef["kind"]): string {
  const labels: Record<SubjectRef["kind"], string> = {
    room: "房间",
    thread: "话题",
    task: "任务",
    decision: "决策",
    artifact: "产物",
    resource: "资源",
    participant: "成员",
  };
  return labels[kind];
}

function presenceLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    offline: "离线",
    starting: "启动中",
    idle: "空闲",
    working: "工作中",
    waiting: "等待中",
    error: "异常",
  };
  return labels[state] ?? state;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
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
    roomId: "room:mesh-preview",
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
