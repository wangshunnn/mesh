import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { RoomSnapshot, WorkspaceConfigPreview } from "@ai-mesh/application";
import {
  CoreAction,
  type RoomEvent,
  type SubjectRef,
  type TaskStatus,
  type TraceRecord,
} from "@ai-mesh/protocol";

import type { DesktopAgentProbe } from "../shared/api.js";
import { TrajectoryView } from "./TrajectoryView.js";

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

const previewConfig: WorkspaceConfigPreview = Object.freeze({
  root: "/workspace/mesh",
  dataDirectory: "/workspace/mesh/.mesh",
  configPath: "/workspace/mesh/.mesh/config.json",
  databasePath: "/workspace/mesh/.mesh/mesh.db",
  revision: null,
  source: "file",
  config: Object.freeze({
    version: 1,
    roomId: "room:mesh-preview",
    agents: Object.freeze([
      Object.freeze({
        id: "agent:opencode",
        name: "OpenCode",
        handle: "opencode",
        adapter: "opencode-acp",
        permissionPolicy: "deny",
        respondToTeam: true,
      }),
      Object.freeze({
        id: "agent:codex",
        name: "Codex",
        handle: "codex",
        adapter: "codex-native",
        permissionPolicy: "deny",
        respondToTeam: true,
      }),
    ]),
  }),
});

type WorkspaceView = "room" | "trajectory" | "configuration";

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);
  const [probes, setProbes] = useState<readonly DesktopAgentProbe[]>([]);
  const [configPreview, setConfigPreview] = useState<WorkspaceConfigPreview | undefined>();
  const [view, setView] = useState<WorkspaceView>("room");
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
      setConfigPreview(previewConfig);
      return () => {
        live = false;
      };
    }
    void Promise.all([
      window.mesh.snapshot(),
      window.mesh.probeAgents(),
      window.mesh.configPreview(),
    ])
      .then(([initial, availability, configuration]) => {
        if (live) {
          setSnapshot(initial);
          setProbes(availability);
          setConfigPreview(configuration);
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
      <Header snapshot={snapshot} busy={busy} invoke={invoke} view={view} onViewChange={setView} />
      {error === undefined ? null : (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>关闭</button>
        </div>
      )}
      <div className={`workspace-grid ${view === "room" ? "" : `${view}-mode`}`}>
        <AgentRail snapshot={snapshot} probes={probes} busy={busy} invoke={invoke} />
        {view === "room" ? (
          <>
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
              <div className="panel-tabs">
                <button type="button" className="active">任务 <span>{snapshot.tasks.length}</span></button>
              </div>
            <TaskPanel snapshot={snapshot} busy={busy} invoke={invoke} />
            </aside>
          </>
        ) : view === "trajectory" ? (
          <TrajectoryView snapshot={snapshot} />
        ) : (
          <ConfigurationView preview={configPreview} probes={probes} />
        )}
      </div>
    </main>
  );
}

interface RuntimeProps {
  readonly snapshot: RoomSnapshot;
  readonly busy: string | undefined;
  readonly invoke: (key: string, operation: () => Promise<RoomSnapshot>) => Promise<boolean>;
}

interface HeaderProps extends RuntimeProps {
  readonly view: WorkspaceView;
  readonly onViewChange: (view: WorkspaceView) => void;
}

function Header({ snapshot, busy, invoke, view, onViewChange }: HeaderProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">M</div>
        <strong>Mesh</strong>
      </div>
      <nav className="breadcrumb" aria-label="工作区视图">
        <span>本地工作区</span>
        <i>/</i>
        <button
          type="button"
          className={view === "room" ? "active" : ""}
          onClick={() => onViewChange("room")}
        >协作房间</button>
        <button
          type="button"
          className={view === "trajectory" ? "active" : ""}
          onClick={() => onViewChange("trajectory")}
        >运行轨迹 <span>{snapshot.trace.length}</span></button>
        <button
          type="button"
          className={view === "configuration" ? "active" : ""}
          onClick={() => onViewChange("configuration")}
        >配置</button>
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

function ConfigurationView({
  preview,
  probes,
}: {
  readonly preview: WorkspaceConfigPreview | undefined;
  readonly probes: readonly DesktopAgentProbe[];
}): React.JSX.Element {
  const availability = useMemo(() => new Map(probes.map((probe) => [probe.id, probe])), [probes]);
  if (preview === undefined) {
    return (
      <section className="configuration-view configuration-loading">
        <strong>正在读取有效配置…</strong>
      </section>
    );
  }
  return (
    <section className="configuration-view">
      <header className="configuration-heading">
        <div>
          <div className="configuration-title-row">
            <h1>工作区配置</h1>
            <span className="readonly-pill">只读预览</span>
          </div>
          <p>展示当前进程实际加载的配置与本地路径，不会修改 <code>config.json</code>。</p>
        </div>
        <div className="configuration-version">
          <span>SCHEMA</span>
          <strong>v{preview.config.version}</strong>
        </div>
      </header>
      <div className="configuration-scroll">
        <section className="configuration-callout">
          <div>
            <span className="eyebrow">本次加载来源</span>
            <strong>{configurationSourceLabel(preview.source)}</strong>
            <p>配置编辑与保存会在确定便携配置、机器本地凭据和迁移边界后接入。</p>
          </div>
          <span className={`source-badge ${preview.source}`}>{preview.source}</span>
        </section>

        <section className="configuration-section">
          <div className="configuration-section-heading">
            <div><span className="eyebrow">WORKSPACE</span><h2>工作区与存储</h2></div>
            <code>{preview.config.roomId}</code>
          </div>
          <dl className="configuration-paths">
            <div><dt>项目根目录</dt><dd><code title={preview.root}>{preview.root}</code></dd></div>
            <div><dt>Mesh 数据目录</dt><dd><code title={preview.dataDirectory}>{preview.dataDirectory}</code></dd></div>
            <div><dt>配置文件</dt><dd><code title={preview.configPath}>{preview.configPath}</code></dd></div>
            <div><dt>SQLite 数据库</dt><dd><code title={preview.databasePath}>{preview.databasePath}</code></dd></div>
          </dl>
        </section>

        <section className="configuration-section">
          <div className="configuration-section-heading">
            <div><span className="eyebrow">AGENTS</span><h2>Agent 运行配置</h2></div>
            <span>{preview.config.agents.length} 个 Agent</span>
          </div>
          <div className="configuration-agents">
            {preview.config.agents.map((agent) => {
              const probe = availability.get(agent.id);
              const command = agent.command ?? (agent.adapter === "opencode-acp" ? "opencode" : "codex");
              return (
                <article className={`configuration-agent avatar-${agent.handle.slice(0, 1)}`} key={agent.id}>
                  <header>
                    <div className="configuration-agent-avatar">{agent.name.slice(0, 1)}</div>
                    <div>
                      <strong>{agent.name}</strong>
                      <span>@{agent.handle} · {agent.id}</span>
                    </div>
                    <span className={`availability-badge ${probe === undefined ? "checking" : probe.available ? "available" : "unavailable"}`}>
                      {probe === undefined ? "检测中" : probe.available ? "可用" : "不可用"}
                    </span>
                  </header>
                  <dl className="configuration-agent-facts">
                    <div><dt>适配器</dt><dd><code>{agent.adapter}</code></dd></div>
                    <div><dt>命令</dt><dd><code>{command}</code>{agent.command === undefined ? <small>默认</small> : null}</dd></div>
                    <div><dt>权限策略</dt><dd>{permissionPolicyLabel(agent.permissionPolicy ?? "deny")}</dd></div>
                    <div><dt>响应全体消息</dt><dd>{agent.respondToTeam === true ? "是" : "否"}</dd></div>
                  </dl>
                  <div className="configuration-prompt">
                    <span>系统提示词</span>
                    <p>{agent.systemPrompt ?? "未覆盖，使用 Mesh 运行时默认提示。"}</p>
                  </div>
                  {probe?.reason === undefined ? null : <p className="configuration-agent-error">{probe.reason}</p>}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </section>
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

function configurationSourceLabel(source: WorkspaceConfigPreview["source"]): string {
  const labels: Readonly<Record<WorkspaceConfigPreview["source"], string>> = {
    default: "内置默认配置",
    file: "工作区配置文件",
    provided: "启动时提供的配置",
  };
  return labels[source];
}

function permissionPolicyLabel(policy: "deny" | "allow-once" | "allow-always"): string {
  const labels = {
    deny: "拒绝工具权限",
    "allow-once": "单次允许",
    "allow-always": "始终允许",
  } as const;
  return labels[policy];
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
