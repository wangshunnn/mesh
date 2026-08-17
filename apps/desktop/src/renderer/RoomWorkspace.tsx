import { useMemo, useState, type FormEvent } from "react";

import { Plus } from "lucide-react";

import type { RoomSnapshot, WorkspaceCatalogView } from "@ai-mesh/application";
import { type SubjectRef, type TaskStatus } from "@ai-mesh/protocol";

import type { DesktopAgentProbe } from "../shared/api.js";
import { displaySessionTitle } from "./format.js";
import { Button, IconButton, SelectControl, TabList } from "./ui/controls.js";

export type WorkspaceView = "room" | "trajectory" | "configuration";

export interface RuntimeProps {
  readonly snapshot: RoomSnapshot;
  readonly busy: string | undefined;
  readonly invoke: (key: string, operation: () => Promise<RoomSnapshot>) => Promise<boolean>;
}

interface HeaderProps extends RuntimeProps {
  readonly catalog: WorkspaceCatalogView | undefined;
  readonly view: WorkspaceView;
  readonly onViewChange: (view: WorkspaceView) => void;
}

export function Header({ snapshot, catalog, busy, invoke, view, onViewChange }: HeaderProps): React.JSX.Element {
  const activeWorkspace = catalog?.workspaces.find(({ id }) => id === catalog.activeWorkspaceId);
  const activeSession = activeWorkspace?.sessions.find(({ id }) => id === catalog?.activeSessionId);
  return (
    <>
      <header className="topbar">
        <div className="session-heading">
          <h1 title={activeSession?.title}>{activeSession === undefined ? "正在载入会话" : displaySessionTitle(activeSession)}</h1>
          <div className="session-context">
            <span>{activeWorkspace?.name ?? "本地工作区"}</span>
            <i />
            <span>共享 Room</span>
            <i />
            <span>{snapshot.agents.length} 个 Agent</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="local-pill"><i /> 本地</span>
          <Button
            tone="primary"
            compact
            className="compact"
            disabled={busy !== undefined}
            onClick={() => void invoke("start-all", () => window.mesh.startAvailableAgents())}
          >
            {busy === "start-all" ? "正在启动…" : "启动可用 Agent"}
          </Button>
        </div>
      </header>
      <nav className="breadcrumb view-tabs" aria-label="会话视图" data-ui="workspace-tabs">
        <TabList
          value={view}
          onValueChange={onViewChange}
          ariaLabel="会话视图"
          items={[
            { value: "room", label: "对话" },
            { value: "trajectory", label: <>轨迹 <span>{snapshot.trace.length}</span></> },
            { value: "configuration", label: "配置" },
          ]}
        />
      </nav>
    </>
  );
}

interface AgentRailProps extends RuntimeProps {
  readonly probes: readonly DesktopAgentProbe[];
}

export function AgentRail({ snapshot, probes, busy, invoke }: AgentRailProps): React.JSX.Element {
  const availability = useMemo(() => new Map(probes.map((probe) => [probe.id, probe])), [probes]);
  return (
    <section className="agent-rail">
      <div className="agent-list">
        <article className="agent-card human-member" title="当前本地用户">
          <div className="agent-card-top">
            <div className="avatar human-avatar">你</div>
            <div className="agent-identity">
              <strong>你</strong>
              <span>在线 · @human</span>
            </div>
            <i className="status-dot idle" title="在线" />
          </div>
        </article>
        {snapshot.agents.map((agent) => {
          const probe = availability.get(agent.id);
          const running = agent.state !== "offline" && agent.state !== "error";
          const action = running ? "stop" : "start";
          const key = `${action}:${agent.id}`;
          return (
            <article
              className="agent-card"
              title={`${agent.adapterKind} · ${probe?.available === false ? "未检测到" : probe?.version ?? "检测中"}`}
              key={agent.id}
            >
              <div className="agent-card-top">
                <div className={`avatar avatar-${agent.handle.slice(0, 1)}`}>{agent.name.slice(0, 1)}</div>
                <div className="agent-identity">
                  <strong>{agent.name}</strong>
                  <span>{presenceLabel(agent.state)} · @{agent.handle}</span>
                </div>
                <i className={`status-dot ${agent.state}`} title={presenceLabel(agent.state)} />
                <button
                  type="button"
                  className="agent-action"
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
    </section>
  );
}

export function MessageList({
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

export function Composer({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [to, setTo] = useState<string>("auto");
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
          <SelectControl
            value={to}
            onValueChange={setTo}
            ariaLabel="消息关注对象"
            options={[
              { value: "auto", label: "自动识别提及" },
              { value: "team", label: "@全体成员" },
              ...snapshot.agents.map((agent) => ({ value: agent.id, label: `@${agent.handle}` })),
            ]}
            className="min-w-[142px]"
          />
        </label>
        <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
        <Button tone="primary" type="submit" disabled={busy !== undefined || text.trim().length === 0}>
          {busy === "send" ? "发送中…" : "发送"}
        </Button>
      </div>
    </form>
  );
}

export function TaskPanel({ snapshot, busy, invoke }: RuntimeProps): React.JSX.Element {
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
        <IconButton
          type="submit"
          className="square !size-[34px] !bg-foreground !text-white hover:!bg-[#343434]"
          label="创建任务"
          disabled={busy !== undefined || title.trim().length === 0}
        ><Plus className="size-4" /></IconButton>
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
                <SelectControl
                  value={task.status}
                  disabled={busy !== undefined}
                  ariaLabel={`更新任务“${task.title}”状态`}
                  options={[
                    { value: "todo", label: "待处理" },
                    { value: "in_progress", label: "进行中" },
                    { value: "blocked", label: "已阻塞" },
                    { value: "review", label: "待评审" },
                    { value: "done", label: "已完成" },
                  ] satisfies readonly { value: TaskStatus; label: string }[]}
                  onValueChange={(status) => void invoke(`task:update:${task.id}`, () => window.mesh.updateTask({
                    taskId: task.id,
                    status,
                  }))}
                  className="max-w-[120px]"
                />
                {task.ownerId === undefined ? (
                  <SelectControl
                    value="unassigned"
                    disabled={busy !== undefined}
                    ariaLabel={`分配任务“${task.title}”`}
                    options={[
                      { value: "unassigned", label: "分配给…" },
                      ...snapshot.agents.map((agent) => ({ value: agent.id, label: `@${agent.handle}` })),
                    ]}
                    onValueChange={(ownerId) => {
                      if (ownerId !== "unassigned") {
                        void invoke(`task:claim:${task.id}`, () => window.mesh.claimTask({
                          taskId: task.id,
                          ownerId,
                        }));
                      }
                    }}
                    className="max-w-[120px]"
                  />
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

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}
