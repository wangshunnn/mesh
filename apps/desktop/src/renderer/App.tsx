import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { RoomSnapshot } from "@ai-mesh/workspace";
import {
  CoreAction,
  type RoomEvent,
  type SubjectRef,
  type TaskStatus,
  type TraceRecord,
} from "@ai-mesh/protocol";

import type { DesktopAgentProbe } from "../shared/api.js";

const emptySnapshot: RoomSnapshot = Object.freeze({
  roomId: "room:loading",
  headSequence: 0,
  agents: Object.freeze([]),
  messages: Object.freeze([]),
  tasks: Object.freeze([]),
  timeline: Object.freeze([]),
  trace: Object.freeze([]),
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
      text: "请 OpenCode 和 Codex 并行梳理登录认证流程，先完成者提交，另一方基于最新状态复核。",
      attention: "team",
      respondingTo: Object.freeze([]),
      createdAt: Date.now() - 120_000,
    }),
    Object.freeze({
      eventId: "preview:message:2",
      sequence: 5,
      threadId: "general",
      from: "agent:opencode",
      text: "刷新令牌路径会经过 session.ts 和 token-store.ts。@human 初步结论已提交。",
      attention: Object.freeze(["human"]),
      respondingTo: Object.freeze(["preview:message:1"]),
      createdAt: Date.now() - 70_000,
    }),
    Object.freeze({
      eventId: "preview:message:3",
      sequence: 8,
      threadId: "general",
      from: "agent:codex",
      text: "已基于最新房间状态复核，两处调用关系一致。@human",
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
  trace: Object.freeze([
    previewTrace(1, "human", "room.event.committed", "committed", Date.now() - 120_000, {
      detail: CoreAction.threadMessageAppend,
      data: { eventId: "preview:message:1", roomSequence: 3, subjectVersion: 1, action: CoreAction.threadMessageAppend },
    }),
    previewTrace(2, "agent:opencode", "agent.turn.started", "running", Date.now() - 116_000, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      detail: "Observing thread version 1.",
      data: { triggerIds: ["preview:message:1"], observedVersion: 1 },
    }),
    previewTrace(3, "agent:codex", "agent.turn.started", "running", Date.now() - 115_988, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      detail: "Observing thread version 1.",
      data: { triggerIds: ["preview:message:1"], observedVersion: 1 },
    }),
    previewTrace(4, "agent:opencode", "agent.session.status", "running", Date.now() - 115_995, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      detail: "ready -> working",
      data: { fromStatus: "ready", toStatus: "working", statusDurationMs: 4 },
    }),
    previewTrace(5, "agent:opencode", "agent.tool.completed", "completed", Date.now() - 108_000, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      detail: "搜索认证相关文件",
      data: { toolCallId: "tool:search-auth" },
    }),
    previewTrace(6, "agent:opencode", "agent.session.status", "completed", Date.now() - 100_500, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      detail: "working -> waiting",
      data: { fromStatus: "working", toStatus: "waiting", statusDurationMs: 15_495 },
    }),
    previewTrace(7, "agent:opencode", "agent.draft.generated", "pending", Date.now() - 100_490, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      content: "刷新令牌路径会经过 session.ts 和 token-store.ts。@human 初步结论已提交。",
      detail: "completed",
      data: { triggerIds: ["preview:message:1"], observedVersion: 1, durationMs: 15_510 },
    }),
    previewTrace(8, "agent:opencode", "room.event.committed", "committed", Date.now() - 100_482, {
      correlationId: "preview:collaboration:auth",
      detail: CoreAction.threadReplyCommit,
      data: {
        eventId: "preview:message:2",
        roomSequence: 5,
        subjectVersion: 2,
        action: CoreAction.threadReplyCommit,
        payload: { respondingTo: ["preview:message:1"] },
      },
    }),
    previewTrace(9, "agent:codex", "agent.turn.dirty", "dirty", Date.now() - 100_481, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      detail: "soft",
      data: {
        impact: "soft",
        changeEventId: "preview:message:2",
        roomSequence: 5,
        basedOnVersion: 1,
        currentVersion: 2,
      },
    }),
    previewTrace(10, "agent:opencode", "agent.draft.committed", "committed", Date.now() - 100_480, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      content: "刷新令牌路径会经过 session.ts 和 token-store.ts。@human 初步结论已提交。",
      detail: "Committed as room event preview:message:2.",
      data: {
        triggerIds: ["preview:message:1"],
        replyEventId: "preview:message:2",
        roomSequence: 5,
        observedVersion: 1,
        validatedVersion: 1,
      },
    }),
    previewTrace(11, "agent:opencode", "agent.turn.completed", "completed", Date.now() - 100_470, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:opencode:auth:v1",
      attempt: 1,
      detail: "replied",
      data: { triggerIds: ["preview:message:1"], observedVersion: 1, durationMs: 15_530 },
    }),
    previewTrace(12, "agent:codex", "agent.session.status", "completed", Date.now() - 84_000, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      detail: "working -> waiting",
      data: { fromStatus: "working", toStatus: "waiting", statusDurationMs: 31_988 },
    }),
    previewTrace(13, "agent:codex", "agent.draft.generated", "pending", Date.now() - 83_990, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      content: "认证路径只经过 session.ts。@human",
      detail: "completed",
      data: { triggerIds: ["preview:message:1"], observedVersion: 1, durationMs: 31_998 },
    }),
    previewTrace(14, "agent:codex", "agent.reconciliation.started", "running", Date.now() - 83_980, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      detail: "Reviewing 1 relevant room change.",
      data: {
        pass: 1,
        basedOnVersion: 1,
        targetVersion: 2,
        changeEventIds: ["preview:message:2"],
      },
    }),
    previewTrace(15, "agent:codex", "agent.reconciliation.decided", "completed", Date.now() - 82_010, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      content: "已基于最新房间状态复核，两处调用关系一致。@human",
      detail: "patch",
      data: {
        pass: 1,
        decision: "patch",
        reason: "OpenCode supplied the missing token-store path.",
        basedOnVersion: 1,
        targetVersion: 2,
        durationMs: 1_970,
      },
    }),
    previewTrace(16, "agent:codex", "agent.draft.committed", "committed", Date.now() - 82_000, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      content: "已基于最新房间状态复核，两处调用关系一致。@human",
      detail: "Committed as room event preview:message:3.",
      data: {
        triggerIds: ["preview:message:1"],
        roomSequence: 8,
        observedVersion: 1,
        validatedVersion: 2,
        reconciliationPasses: 1,
      },
    }),
    previewTrace(17, "agent:codex", "agent.turn.completed", "completed", Date.now() - 81_990, {
      correlationId: "preview:collaboration:auth",
      turnId: "turn:codex:auth:v1",
      attempt: 1,
      detail: "replied",
      data: {
        triggerIds: ["preview:message:1"],
        observedVersion: 1,
        finalBasisVersion: 2,
        reconciliationPasses: 1,
        durationMs: 34_010,
      },
    }),
  ]),
});

type RightPanel = "tasks" | "trace";

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
              className={panel === "trace" ? "active" : ""}
              aria-selected={panel === "trace"}
              onClick={() => setPanel("trace")}
            >
              轨迹 <span>{snapshot.trace.length}</span>
            </button>
          </div>
          {panel === "tasks" ? (
            <TaskPanel snapshot={snapshot} busy={busy} invoke={invoke} />
          ) : (
            <TracePanel snapshot={snapshot} />
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

type TraceView = "rounds" | "events";

interface TraceAttemptGroup {
  readonly id: string;
  readonly actorId: string;
  readonly attempt: number;
  readonly records: readonly TraceRecord[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: TraceRecord["status"];
}

interface TraceAgentLane {
  readonly actorId: string;
  readonly attempts: readonly TraceAttemptGroup[];
  readonly startedAt: number;
  readonly endedAt: number;
}

interface TraceRoundGroup {
  readonly id: string;
  readonly triggerIds: readonly string[];
  readonly records: readonly TraceRecord[];
  readonly lanes: readonly TraceAgentLane[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: TraceRecord["status"];
}

function TracePanel({ snapshot }: { readonly snapshot: RoomSnapshot }): React.JSX.Element {
  const [view, setView] = useState<TraceView>("rounds");
  const records = useMemo(
    () => snapshot.trace
      .slice()
      .sort((left, right) => right.occurredAt - left.occurredAt || right.sequence - left.sequence),
    [snapshot.trace],
  );
  const rounds = useMemo(() => buildTraceRounds(snapshot.trace), [snapshot.trace]);
  const issueCount = records.filter(
    (record) => record.status === "expired" || record.status === "failed",
  ).length;
  return (
    <div className="panel-content trace-panel" role="tabpanel" aria-label="轨迹">
      <header className="trace-intro">
        <div>
          <strong>运行时调试看板</strong>
          <p>并发协作按轮次归组，原始事件完整保留</p>
        </div>
        {issueCount === 0 ? null : <span>{issueCount} 条需关注</span>}
      </header>
      <div className="trace-view-switch" role="tablist" aria-label="轨迹视图">
        <button
          className={view === "rounds" ? "active" : ""}
          onClick={() => setView("rounds")}
          role="tab"
          aria-selected={view === "rounds"}
        >
          协作轮次 <span>{rounds.length}</span>
        </button>
        <button
          className={view === "events" ? "active" : ""}
          onClick={() => setView("events")}
          role="tab"
          aria-selected={view === "events"}
        >
          原始事件 <span>{records.length}</span>
        </button>
        <small>{view === "rounds" ? "轮次内正序" : "最新在上"}</small>
      </div>
      {view === "rounds" ? (
        rounds.length === 0 ? (
          <div className="small-empty">
            <strong>还没有协作轮次</strong>
            <p>发送房间消息后，每个 Agent 的并发处理、提交和重算会归到同一轮。</p>
          </div>
        ) : (
          <div className="trace-round-list">
            {rounds.map((round) => <TraceRoundCard key={round.id} round={round} snapshot={snapshot} />)}
          </div>
        )
      ) : records.length === 0 ? (
        <div className="small-empty"><strong>还没有轨迹</strong><p>Agent 启动、工具调用、候选回复和提交结果都会记录在这里。</p></div>
      ) : (
        <TraceEventList records={records} snapshot={snapshot} />
      )}
      <p className="trace-boundary">轨迹是本地诊断信息，不会进入 Agent 的共享上下文。</p>
    </div>
  );
}

function TraceRoundCard({
  snapshot,
  round,
}: {
  readonly snapshot: RoomSnapshot;
  readonly round: TraceRoundGroup;
}): React.JSX.Element {
  const trigger = snapshot.messages.find((message) => round.triggerIds.includes(message.eventId));
  const firstStarts = round.lanes.map((lane) => lane.startedAt);
  const startSpread = firstStarts.length < 2 ? 0 : Math.max(...firstStarts) - Math.min(...firstStarts);
  const expiredCount = round.records.filter((record) => record.status === "expired").length;
  const causalSteps = traceRoundCausalSteps(snapshot, round);
  return (
    <article className={`trace-round ${round.status}`}>
      <header className="trace-round-header">
        <div>
          <strong>{trigger === undefined ? "协作轮次" : `房间消息 #${String(trigger.sequence)}`}</strong>
          <p>
            {round.lanes.length} 个 Agent
            {round.lanes.length < 2 ? "" : ` · 启动相差 ${formatDuration(startSpread)}`}
            {` · 总计 ${formatDuration(round.endedAt - round.startedAt)}`}
          </p>
        </div>
        <span className={`trace-status ${round.status}`}>
          {expiredCount > 0 ? `${expiredCount} 次重算` : traceStatusLabel(round.status)}
        </span>
      </header>
      {trigger === undefined ? null : <p className="trace-trigger">{renderMentions(trigger.text)}</p>}
      {causalSteps.length === 0 ? null : (
        <div className="trace-causal" aria-label="因果链">
          {causalSteps.map((step) => <span className={step.tone} key={step.id}>{step.label}</span>)}
        </div>
      )}
      <div className="trace-lanes">
        {round.lanes.map((lane) => (
          <TraceLane key={lane.actorId} lane={lane} snapshot={snapshot} />
        ))}
      </div>
      <footer className="trace-round-footer">
        <time>{formatTraceClock(round.startedAt)}</time>
        <code>{round.id.replace(/^collaboration:/, "C").slice(0, 9)}</code>
      </footer>
    </article>
  );
}

function TraceLane({
  snapshot,
  lane,
}: {
  readonly snapshot: RoomSnapshot;
  readonly lane: TraceAgentLane;
}): React.JSX.Element {
  return (
    <section className="trace-lane">
      <header className="trace-lane-header">
        <span className={`trace-agent-mark ${lane.actorId.split(":").at(-1)?.slice(0, 1) ?? "a"}`}>
          {participantInitial(lane.actorId)}
        </span>
        <div>
          <strong>{participantName(snapshot, lane.actorId)}</strong>
          <small>{participantLabel(snapshot, lane.actorId)} · {formatTraceClock(lane.startedAt)}</small>
        </div>
        <time>{formatDuration(lane.endedAt - lane.startedAt)}</time>
      </header>
      <div className="trace-attempts">
        {lane.attempts.map((attempt) => (
          <TraceAttempt key={attempt.id} attempt={attempt} />
        ))}
      </div>
    </section>
  );
}

function TraceAttempt({ attempt }: { readonly attempt: TraceAttemptGroup }): React.JSX.Element {
  const observedVersion = attempt.records.find(
    (record) => typeof record.data?.observedVersion === "number",
  )?.data?.observedVersion;
  const generatedCandidate = attempt.records.find(
    (record) => record.kind === "agent.draft.generated" && record.content !== undefined,
  );
  const finalCandidate = attempt.records
    .slice()
    .reverse()
    .find(
      (record) =>
        record.content !== undefined &&
        (record.kind === "agent.draft.committed" ||
          (record.kind === "agent.reconciliation.decided" && record.data?.decision === "patch") ||
          record.kind === "agent.draft.expired"),
    ) ?? generatedCandidate;
  const candidateChanged =
    generatedCandidate?.content !== undefined &&
    finalCandidate?.content !== undefined &&
    generatedCandidate.content !== finalCandidate.content;
  const eventRecords = attempt.records.filter((record) => isAttemptMilestone(record));
  return (
    <article className={`trace-attempt ${attempt.status}`}>
      <header>
        <strong>第 {attempt.attempt} 次</strong>
        <span>
          {typeof observedVersion === "number" ? `基于 v${String(observedVersion)} · ` : ""}
          {formatDuration(traceAttemptDuration(attempt))}
        </span>
        <b className={`trace-status ${attempt.status}`}>{traceAttemptStatusLabel(attempt)}</b>
      </header>
      <div className="trace-attempt-flow">
        {eventRecords.map((record) => (
          <span className={record.status} key={record.id}>{traceMilestoneLabel(record)}</span>
        ))}
      </div>
      {finalCandidate?.content === undefined ? null : (
        <details
          className={`trace-content ${attempt.status}`}
          open={attempt.status === "expired" || attempt.status === "failed"}
        >
          <summary>
            {attempt.status === "expired"
              ? "未发送内容"
              : candidateChanged
                ? "候选已局部修正"
                : "候选内容"}
          </summary>
          <pre>
            {candidateChanged
              ? `调和前\n${generatedCandidate?.content ?? ""}\n\n修正后\n${finalCandidate.content}`
              : finalCandidate.content}
          </pre>
        </details>
      )}
      <details className="trace-attempt-events">
        <summary>{attempt.records.length} 条内部事件</summary>
        <div>
          {attempt.records.map((record) => (
            <p key={record.id}>
              <time>{formatTraceClock(record.occurredAt)}</time>
              <span>{traceLabel(record)}</span>
              <code>T{record.sequence}</code>
            </p>
          ))}
        </div>
      </details>
    </article>
  );
}

function TraceEventList({
  snapshot,
  records,
}: {
  readonly snapshot: RoomSnapshot;
  readonly records: readonly TraceRecord[];
}): React.JSX.Element {
  return (
    <div className="trace-list">
      {records.map((record) => {
        const visibleDetail = traceVisibleDetail(record);
        return (
          <article className={`trace-item ${record.status}`} key={record.id}>
            <div className="trace-rail" aria-hidden="true"><i /></div>
            <div className="trace-entry">
              <header>
                <strong>{traceLabel(record)}</strong>
                <span className={`trace-status ${record.status}`}>{traceStatusLabel(record.status)}</span>
              </header>
              <p className="trace-meta">{traceMeta(snapshot, record)}</p>
              {record.content === undefined ? null : (
                <details
                  className={`trace-content ${record.status}`}
                  open={record.status === "expired" || record.status === "failed"}
                >
                  <summary>{traceContentLabel(record)}</summary>
                  <pre>{record.content}</pre>
                </details>
              )}
              {visibleDetail === undefined ? null : <p className="trace-detail">{visibleDetail}</p>}
              <details className="trace-data">
                <summary>事件详情</summary>
                <pre>{JSON.stringify(traceDebugData(record), undefined, 2)}</pre>
              </details>
              <footer>
                <time>{formatTraceClock(record.occurredAt)}</time>
                <code>T{record.sequence}</code>
              </footer>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function buildTraceRounds(records: readonly TraceRecord[]): readonly TraceRoundGroup[] {
  const ordered = records
    .slice()
    .sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence);
  const turnCorrelations = new Map<string, string>();
  for (const record of ordered) {
    const correlationId = record.correlationId ?? legacyTraceCorrelation(record);
    if (record.turnId !== undefined && correlationId !== undefined) {
      turnCorrelations.set(record.turnId, correlationId);
    }
  }

  const groups = new Map<string, { records: TraceRecord[]; triggerIds: Set<string> }>();
  for (const record of ordered) {
    const correlationId =
      record.correlationId ??
      (record.turnId === undefined ? undefined : turnCorrelations.get(record.turnId)) ??
      legacyTraceCorrelation(record);
    if (correlationId === undefined) {
      continue;
    }
    const group = groups.get(correlationId) ?? { records: [], triggerIds: new Set<string>() };
    group.records.push(record);
    for (const triggerId of traceTriggerIds(record)) {
      group.triggerIds.add(triggerId);
    }
    groups.set(correlationId, group);
  }

  for (const group of groups.values()) {
    for (const record of ordered) {
      const eventId = record.data?.eventId;
      if (
        record.kind === "room.event.committed" &&
        typeof eventId === "string" &&
        group.triggerIds.has(eventId) &&
        !group.records.some((candidate) => candidate.id === record.id)
      ) {
        group.records.push(record);
      }
    }
    group.records.sort(
      (left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence,
    );
  }

  return [...groups.entries()]
    .map(([id, group]) => createTraceRound(id, group.records, [...group.triggerIds]))
    .filter((round) => round.lanes.length > 0)
    .sort((left, right) => right.startedAt - left.startedAt);
}

function createTraceRound(
  id: string,
  records: readonly TraceRecord[],
  triggerIds: readonly string[],
): TraceRoundGroup {
  const byTurn = new Map<string, TraceRecord[]>();
  for (const record of records) {
    if (record.turnId === undefined || !record.kind.startsWith("agent.")) {
      continue;
    }
    const attemptRecords = byTurn.get(record.turnId) ?? [];
    attemptRecords.push(record);
    byTurn.set(record.turnId, attemptRecords);
  }
  const attempts = [...byTurn.entries()].map(([turnId, attemptRecords]) => {
    const ordered = attemptRecords
      .slice()
      .sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence);
    return Object.freeze({
      id: turnId,
      actorId: ordered[0]?.actorId ?? "unknown",
      attempt: ordered.find((record) => record.attempt !== undefined)?.attempt ?? 1,
      records: Object.freeze(ordered),
      startedAt: ordered[0]?.occurredAt ?? 0,
      endedAt: ordered.at(-1)?.occurredAt ?? 0,
      status: traceAttemptStatus(ordered),
    });
  });
  const byActor = new Map<string, TraceAttemptGroup[]>();
  for (const attempt of attempts) {
    const actorAttempts = byActor.get(attempt.actorId) ?? [];
    actorAttempts.push(attempt);
    byActor.set(attempt.actorId, actorAttempts);
  }
  const lanes = [...byActor.entries()].map(([actorId, actorAttempts]) => {
    const ordered = actorAttempts.slice().sort((left, right) => left.startedAt - right.startedAt);
    return Object.freeze({
      actorId,
      attempts: Object.freeze(ordered),
      startedAt: ordered[0]?.startedAt ?? 0,
      endedAt: Math.max(...ordered.map((attempt) => attempt.endedAt)),
    });
  }).sort((left, right) => left.startedAt - right.startedAt);
  const startedAt = lanes.length === 0
    ? records[0]?.occurredAt ?? 0
    : Math.min(...lanes.map((lane) => lane.startedAt));
  const endedAt = lanes.length === 0
    ? records.at(-1)?.occurredAt ?? startedAt
    : Math.max(...lanes.map((lane) => lane.endedAt));
  return Object.freeze({
    id,
    triggerIds: Object.freeze([...triggerIds]),
    records: Object.freeze([...records]),
    lanes: Object.freeze(lanes),
    startedAt,
    endedAt,
    status: traceRoundStatus(lanes),
  });
}

function traceAttemptStatus(records: readonly TraceRecord[]): TraceRecord["status"] {
  if (records.some((record) => record.status === "failed")) return "failed";
  if (records.some((record) => record.status === "expired")) return "expired";
  if (records.some((record) => record.kind === "agent.draft.committed")) return "committed";
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.kind === "agent.turn.completed") return record.status;
  }
  if (records.some((record) => record.status === "pending")) return "pending";
  if (records.some((record) => record.status === "running")) return "running";
  return records.at(-1)?.status ?? "info";
}

function traceRoundStatus(lanes: readonly TraceAgentLane[]): TraceRecord["status"] {
  const latest = lanes.map((lane) => lane.attempts.at(-1)?.status ?? "info");
  if (latest.some((status) => status === "failed")) return "failed";
  if (latest.some((status) => status === "running" || status === "dirty" || status === "pending")) return "running";
  if (latest.some((status) => status === "cancelled")) return "cancelled";
  return "completed";
}

function traceTriggerIds(record: TraceRecord): readonly string[] {
  const direct = record.data?.triggerIds;
  if (Array.isArray(direct) && direct.every((id) => typeof id === "string")) {
    return direct as string[];
  }
  const payload = record.data?.payload;
  if (isUnknownRecord(payload)) {
    const respondingTo = payload.respondingTo;
    if (Array.isArray(respondingTo) && respondingTo.every((id) => typeof id === "string")) {
      return respondingTo as string[];
    }
  }
  return Object.freeze([]);
}

function legacyTraceCorrelation(record: TraceRecord): string | undefined {
  const triggerIds = traceTriggerIds(record);
  return triggerIds.length === 0
    ? undefined
    : `legacy:${triggerIds.slice().sort().join("|")}`;
}

function traceRoundCausalSteps(
  snapshot: RoomSnapshot,
  round: TraceRoundGroup,
): readonly { readonly id: string; readonly label: string; readonly tone: string }[] {
  const steps: { id: string; label: string; tone: string }[] = [];
  const tracedReplyEventIds = new Set(
    round.records
      .filter(
        (record) =>
          record.kind === "room.event.committed" &&
          record.data?.action === CoreAction.threadReplyCommit &&
          typeof record.data?.eventId === "string",
      )
      .map((record) => record.data?.eventId as string),
  );
  const firstStarts = round.lanes.map((lane) => lane.startedAt);
  if (firstStarts.length > 1) {
    const spread = Math.max(...firstStarts) - Math.min(...firstStarts);
    steps.push({
      id: `${round.id}:parallel`,
      label: `${String(firstStarts.length)} 个 Agent 在 ${formatDuration(spread)} 内并发开始`,
      tone: "running",
    });
  }
  for (const record of round.records) {
    if (
      record.kind === "room.event.committed" &&
      record.data?.action === CoreAction.threadReplyCommit
    ) {
      const roomSequence = record.data?.roomSequence;
      steps.push({
        id: record.id,
        label: `${participantName(snapshot, record.actorId)} 提交${typeof roomSequence === "number" ? ` #${String(roomSequence)}` : ""}`,
        tone: "committed",
      });
    } else if (
      record.kind === "agent.draft.committed" &&
      !tracedReplyEventIds.has(String(record.data?.replyEventId ?? ""))
    ) {
      const roomSequence = record.data?.roomSequence;
      steps.push({
        id: record.id,
        label: `${participantName(snapshot, record.actorId)} 提交${typeof roomSequence === "number" ? ` #${String(roomSequence)}` : ""}`,
        tone: "committed",
      });
    } else if (record.kind === "agent.draft.expired") {
      const observed = record.data?.observedVersion;
      const current = record.data?.currentVersion;
      steps.push({
        id: record.id,
        label: `${participantName(snapshot, record.actorId)} 候选过期${typeof observed === "number" && typeof current === "number" ? ` v${String(observed)}→v${String(current)}` : ""}`,
        tone: "expired",
      });
    } else if (record.kind === "agent.turn.dirty") {
      steps.push({
        id: record.id,
        label: `${participantName(snapshot, record.actorId)} 标记待调和`,
        tone: "dirty",
      });
    } else if (record.kind === "agent.reconciliation.decided") {
      const decision = record.data?.decision;
      if (typeof decision === "string") {
        steps.push({
          id: record.id,
          label: `${participantName(snapshot, record.actorId)} ${reconciliationDecisionLabel(decision)}`,
          tone: decision === "regenerate" ? "expired" : decision === "drop" ? "cancelled" : "completed",
        });
      }
    } else if (record.kind === "agent.turn.started" && (record.attempt ?? 1) > 1) {
      steps.push({
        id: record.id,
        label: `${participantName(snapshot, record.actorId)} 第 ${String(record.attempt)} 次重算`,
        tone: "running",
      });
    } else if (record.kind === "agent.turn.failed") {
      steps.push({ id: record.id, label: `${participantName(snapshot, record.actorId)} 处理失败`, tone: "failed" });
    }
  }
  return Object.freeze(steps);
}

function traceAttemptDuration(attempt: TraceAttemptGroup): number {
  for (let index = attempt.records.length - 1; index >= 0; index -= 1) {
    const duration = attempt.records[index]?.data?.durationMs;
    if (typeof duration === "number" && Number.isFinite(duration)) {
      return Math.max(0, duration);
    }
  }
  return Math.max(0, attempt.endedAt - attempt.startedAt);
}

function traceAttemptStatusLabel(attempt: TraceAttemptGroup): string {
  if (attempt.status === "expired") return "候选过期";
  if (attempt.status === "committed") return "已提交";
  if (attempt.status === "failed") return "失败";
  if (attempt.status === "cancelled") return "已取消";
  if (attempt.status === "pending") return "待提交";
  if (attempt.status === "dirty") return "待调和";
  if (attempt.status === "running") return "生成中";
  return "已结束";
}

function isAttemptMilestone(record: TraceRecord): boolean {
  return record.kind === "agent.turn.started" ||
    record.kind === "agent.turn.dirty" ||
    record.kind === "agent.reconciliation.started" ||
    record.kind === "agent.reconciliation.decided" ||
    record.kind === "agent.session.status" ||
    record.kind.startsWith("agent.tool.") ||
    record.kind === "agent.draft.generated" ||
    record.kind === "agent.draft.expired" ||
    record.kind === "agent.draft.committed" ||
    record.kind === "agent.turn.completed" ||
    record.kind === "agent.turn.failed";
}

function traceMilestoneLabel(record: TraceRecord): string {
  if (record.kind === "agent.turn.started") return (record.attempt ?? 1) > 1 ? "重新读取房间" : "开始";
  if (record.kind === "agent.turn.dirty") return "Room 已变化，继续生成";
  if (record.kind === "agent.reconciliation.started") return "检查增量影响";
  if (record.kind === "agent.reconciliation.decided") {
    const decision = record.data?.decision;
    return typeof decision === "string" ? reconciliationDecisionLabel(decision) : "完成候选调和";
  }
  if (record.kind === "agent.session.status") return traceSessionTransition(record) ?? "会话状态变化";
  if (record.kind.startsWith("agent.tool.")) return `工具：${record.detail ?? "调用"}`;
  if (record.kind === "agent.draft.generated") return "候选完成";
  if (record.kind === "agent.draft.expired") return "提交冲突，候选过期";
  if (record.kind === "agent.draft.committed") {
    const roomSequence = record.data?.roomSequence;
    return typeof roomSequence === "number" ? `提交 #${String(roomSequence)}` : "提交";
  }
  if (record.kind === "agent.turn.failed") return "失败";
  if (record.kind === "agent.turn.completed") return "结束";
  return traceLabel(record);
}

function traceSessionTransition(record: TraceRecord): string | undefined {
  const from = record.data?.fromStatus;
  const to = record.data?.toStatus;
  if (typeof from === "string" && typeof to === "string") {
    return `${presenceLabel(from)} → ${presenceLabel(to)}`;
  }
  if (record.kind === "agent.session.status" && typeof record.detail === "string") {
    const [legacyFrom, legacyTo] = record.detail.split(" -> ");
    if (legacyFrom !== undefined && legacyTo !== undefined) {
      return `${presenceLabel(legacyFrom)} → ${presenceLabel(legacyTo)}`;
    }
    if (record.detail === "working") return "开始生成";
    if (record.detail === "waiting") return "生成结束，进入等待";
    return `进入${presenceLabel(record.detail)}`;
  }
  return undefined;
}

function reconciliationDecisionLabel(decision: string): string {
  const labels: Readonly<Record<string, string>> = {
    keep: "确认候选不变",
    patch: "局部修正候选",
    regenerate: "决定完整重算",
    drop: "确认无需回复",
  };
  return labels[decision] ?? decision;
}

function traceContentLabel(record: TraceRecord): string {
  if (record.status === "expired") return "未发送内容";
  if (record.kind === "agent.reconciliation.decided" && record.data?.decision === "patch") {
    return "修正后候选";
  }
  return "候选内容";
}

function traceVisibleDetail(record: TraceRecord): string | undefined {
  if (record.kind === "agent.session.status") return undefined;
  if (record.kind === "room.event.committed") return undefined;
  if (record.kind === "agent.turn.started" && typeof record.data?.observedVersion === "number") {
    return `读取房间 v${String(record.data.observedVersion)} 后开始生成。`;
  }
  if (record.kind === "agent.turn.dirty") return "检测到相关 Room 变化；当前生成继续，不会立即取消。";
  if (record.kind === "agent.reconciliation.started") return "正在用原候选和 Room 增量进行轻量调和。";
  if (record.kind === "agent.reconciliation.decided") {
    const decision = record.data?.decision;
    const reason = record.data?.reason;
    const summary = typeof decision === "string"
      ? `调和结论：${reconciliationDecisionLabel(decision)}。`
      : "候选调和已结束。";
    return typeof reason === "string" ? `${summary} ${reason}` : summary;
  }
  if (record.kind === "agent.draft.generated") return "候选回复生成完成，尚未提交。";
  if (record.kind === "agent.draft.expired") return "房间已推进，此候选没有发送，并将基于最新状态重算。";
  if (record.kind === "agent.draft.committed") {
    const roomSequence = record.data?.roomSequence;
    return typeof roomSequence === "number"
      ? `候选已提交为房间消息 #${String(roomSequence)}。`
      : "候选已提交为房间消息。";
  }
  if (record.kind === "agent.turn.completed") {
    const outcomes: Readonly<Record<string, string>> = {
      replied: "本次处理已提交回复。",
      empty: "本次处理没有生成回复。",
      cancelled: "本次处理已取消。",
      refused: "Agent 拒绝了本次处理。",
      error: "本次处理因异常结束。",
    };
    return record.detail === undefined ? undefined : outcomes[record.detail] ?? record.detail;
  }
  return record.detail;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function traceLabel(record: TraceRecord): string {
  if (record.kind === "room.event.committed") {
    const action = record.data?.action;
    return typeof action === "string" ? activityLabel(action) : "提交了房间事件";
  }
  if (record.kind === "agent.session.status") {
    return traceSessionTransition(record) ?? "会话状态变化";
  }
  const labels: Readonly<Record<string, string>> = {
    "agent.session.starting": "正在启动 Agent 会话",
    "agent.session.ready": "Agent 会话已就绪",
    "agent.session.stopping": "正在停止 Agent 会话",
    "agent.session.stopped": "Agent 会话已停止",
    "agent.session.failed": "Agent 会话启动失败",
    "agent.session.error": "Agent 会话异常",
    "agent.turn.started": "开始处理房间状态",
    "agent.turn.dirty": "检测到相关 Room 变化",
    "agent.turn.result": "生成过程已结束",
    "agent.turn.completed": "一轮处理已结束",
    "agent.turn.failed": "一轮处理失败",
    "agent.draft.generated": "生成了候选回复",
    "agent.draft.expired": "候选回复已过期",
    "agent.draft.committed": "候选回复已提交",
    "agent.reconciliation.started": "开始调和候选",
    "agent.reconciliation.decided": "候选调和已完成",
    "agent.tool.started": "开始调用工具",
    "agent.tool.completed": "工具调用完成",
    "agent.tool.failed": "工具调用失败",
  };
  return labels[record.kind] ?? record.kind;
}

function traceStatusLabel(status: TraceRecord["status"]): string {
  const labels: Record<TraceRecord["status"], string> = {
    info: "信息",
    running: "进行中",
    dirty: "待调和",
    pending: "待提交",
    committed: "已提交",
    completed: "已完成",
    expired: "已过期",
    cancelled: "已取消",
    failed: "失败",
  };
  return labels[status];
}

function traceMeta(snapshot: RoomSnapshot, record: TraceRecord): string {
  const parts = [participantLabel(snapshot, record.actorId)];
  const roomSequence = record.data?.roomSequence;
  if (typeof roomSequence === "number") {
    parts.push(`room #${String(roomSequence)}`);
  }
  if (record.attempt !== undefined) {
    parts.push(`第 ${String(record.attempt)} 次`);
  }
  const observedVersion = record.data?.observedVersion ?? record.data?.basedOnVersion;
  const currentVersion = record.data?.currentVersion ?? record.data?.targetVersion;
  if (typeof observedVersion === "number") {
    parts.push(
      typeof currentVersion === "number"
        ? `v${String(observedVersion)} → v${String(currentVersion)}`
        : `基于 v${String(observedVersion)}`,
    );
  }
  const duration = record.data?.durationMs ?? record.data?.statusDurationMs;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    parts.push(formatDuration(duration));
  }
  return parts.join(" · ");
}

function traceDebugData(record: TraceRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    actorId: record.actorId,
    ...(record.correlationId === undefined ? {} : { correlationId: record.correlationId }),
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
    ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
    ...(record.data === undefined ? {} : { data: record.data }),
  };
}

function formatDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds);
  if (duration < 1_000) return `${String(Math.round(duration))} ms`;
  if (duration < 10_000) return `${(duration / 1_000).toFixed(2)} s`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.round((duration % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

function formatTraceClock(timestamp: number): string {
  return `${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp)}.${String(new Date(timestamp).getMilliseconds()).padStart(3, "0")}`;
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
    ready: "就绪",
    idle: "空闲",
    working: "工作中",
    waiting: "等待中",
    stopping: "停止中",
    stopped: "已停止",
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

function previewTrace(
  sequence: number,
  actorId: string,
  kind: string,
  status: TraceRecord["status"],
  occurredAt: number,
  options: Pick<TraceRecord, "detail" | "data"> &
    Partial<Pick<TraceRecord, "correlationId" | "turnId" | "attempt" | "content">>,
): TraceRecord {
  return Object.freeze({
    id: `preview:trace:${String(sequence)}`,
    sequence,
    roomId: "room:mesh-preview",
    actorId,
    kind,
    status,
    occurredAt,
    ...options,
  });
}
