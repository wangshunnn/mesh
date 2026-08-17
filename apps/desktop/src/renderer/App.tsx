import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type {
  RoomSnapshot,
  WorkspaceCatalogView,
  WorkspaceConfigPreview,
  WorkspaceConfigSaveInput,
  WorkspaceConfigWriteResult,
  WorkspaceSelectionView,
} from "@ai-mesh/application";
import {
  CoreAction,
  type RoomEvent,
  type SubjectRef,
  type TaskStatus,
  type TraceRecord,
} from "@ai-mesh/protocol";

import type { DesktopAgentProbe } from "../shared/api.js";
import { ConfigurationView } from "./ConfigurationView.js";
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

function isWorkspaceTransitionBusy(busy: string | undefined): boolean {
  return busy === "open-workspace"
    || busy?.startsWith("create-session:") === true
    || busy?.startsWith("select-session:") === true;
}

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
  workspaceId: "7eea79bc-9cbf-4d29-950b-c97ab0f52bdf",
  sessionId: "session-1d37f64f-9365-4f44-9c06-c0e69b29c902",
  root: "/workspace/mesh",
  meshHome: "/Users/demo/.mesh",
  projectKey: "--workspace-mesh--b5f31f1eb2c0",
  registryPath: "/Users/demo/.mesh/storages/workspace.json",
  projectionCachePath: "/Users/demo/.mesh/storages/session-projection-cache.json",
  sessionDirectory: "/Users/demo/.mesh/sessions/--workspace-mesh--b5f31f1eb2c0/session-1d37f64f-9365-4f44-9c06-c0e69b29c902",
  headerPath: "/Users/demo/.mesh/sessions/--workspace-mesh--b5f31f1eb2c0/session-1d37f64f-9365-4f44-9c06-c0e69b29c902/header.json",
  dataDirectory: "/Users/demo/.mesh/sessions/--workspace-mesh--b5f31f1eb2c0/session-1d37f64f-9365-4f44-9c06-c0e69b29c902",
  configPath: "/Users/demo/.mesh/sessions/--workspace-mesh--b5f31f1eb2c0/session-1d37f64f-9365-4f44-9c06-c0e69b29c902/config.json",
  databasePath: "/Users/demo/.mesh/sessions/--workspace-mesh--b5f31f1eb2c0/session-1d37f64f-9365-4f44-9c06-c0e69b29c902/mesh.db",
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

const previewCatalog: WorkspaceCatalogView = Object.freeze({
  activeWorkspaceId: previewConfig.workspaceId,
  activeSessionId: previewConfig.sessionId,
  workspaces: Object.freeze([
    Object.freeze({
      id: previewConfig.workspaceId,
      name: "mesh",
      root: previewConfig.root,
      status: "available",
      createdAt: "2026-08-17T08:20:00.000Z",
      updatedAt: "2026-08-17T09:42:00.000Z",
      lastOpenedAt: "2026-08-17T09:42:00.000Z",
      sessions: Object.freeze([
        Object.freeze({
          id: previewConfig.sessionId,
          workspaceId: previewConfig.workspaceId,
          status: "ok",
          title: "复核登录认证流程",
          preview: "已基于最新房间状态复核，两处调用关系一致。",
          createdAt: "2026-08-17T08:20:00.000Z",
          updatedAt: "2026-08-17T09:42:00.000Z",
          headSequence: previewSnapshot.headSequence,
          messageCount: previewSnapshot.messages.length,
          archived: false,
        }),
        Object.freeze({
          id: "session-preview-empty",
          workspaceId: previewConfig.workspaceId,
          status: "ok",
          title: "New Session",
          preview: "",
          createdAt: "2026-08-16T15:10:00.000Z",
          updatedAt: "2026-08-16T15:10:00.000Z",
          headSequence: 0,
          messageCount: 0,
          archived: false,
        }),
      ]),
    }),
  ]),
});

type WorkspaceView = "room" | "trajectory" | "configuration";
const sidebarSessionLimit = 5;

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);
  const [catalog, setCatalog] = useState<WorkspaceCatalogView | undefined>();
  const [probes, setProbes] = useState<readonly DesktopAgentProbe[]>([]);
  const [configPreview, setConfigPreview] = useState<WorkspaceConfigPreview | undefined>();
  const [view, setView] = useState<WorkspaceView>("room");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
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
      setCatalog(previewCatalog);
      return () => {
        live = false;
      };
    }
    void Promise.all([
      window.mesh.snapshot(),
      window.mesh.probeAgents(),
      window.mesh.configPreview(),
      window.mesh.workspaceCatalog(),
    ])
      .then(([initial, availability, configuration, workspaceCatalog]) => {
        if (live) {
          setSnapshot(initial);
          setProbes(availability);
          setConfigPreview(configuration);
          setCatalog(workspaceCatalog);
        }
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
    const unsubscribe = window.mesh.onSnapshot((next) => {
      if (live) {
        setSnapshot(next);
      }
    });
    const unsubscribeCatalog = window.mesh.onWorkspaceCatalog((next) => {
      if (live) setCatalog(next);
    });
    return () => {
      live = false;
      unsubscribe();
      unsubscribeCatalog();
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

  const saveConfiguration = async (
    input: WorkspaceConfigSaveInput,
  ): Promise<WorkspaceConfigWriteResult | undefined> => {
    setBusy("save-config");
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式不能保存配置，请打开 Electron 应用。");
      }
      const result = await window.mesh.saveConfig(input);
      const [nextSnapshot, nextProbes, nextPreview] = await Promise.all([
        window.mesh.snapshot(),
        window.mesh.probeAgents(),
        window.mesh.configPreview(),
      ]);
      setSnapshot(nextSnapshot);
      setProbes(nextProbes);
      setConfigPreview(nextPreview);
      return result;
    } catch (caught) {
      setError(configurationErrorMessage(caught));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const reloadConfiguration = async (): Promise<boolean> => {
    setBusy("reload-config");
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式不能重新加载配置，请打开 Electron 应用。");
      }
      const nextPreview = await window.mesh.reloadConfig();
      const [nextSnapshot, nextProbes] = await Promise.all([
        window.mesh.snapshot(),
        window.mesh.probeAgents(),
      ]);
      setConfigPreview(nextPreview);
      setSnapshot(nextSnapshot);
      setProbes(nextProbes);
      return true;
    } catch (caught) {
      setError(configurationErrorMessage(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const transitionWorkspace = async (
    key: string,
    operation: () => Promise<WorkspaceSelectionView | undefined>,
  ): Promise<boolean> => {
    setBusy(key);
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式不能切换工作区或会话，请打开 Electron 应用。");
      }
      const selection = await operation();
      if (selection === undefined) return false;
      setSnapshot(selection.snapshot);
      setCatalog(selection.catalog);
      setConfigPreview(selection.configPreview);
      setProbes(await window.mesh.probeAgents());
      setView("room");
      return true;
    } catch (caught) {
      setError(workspaceErrorMessage(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const openWorkspace = (): void => {
    void transitionWorkspace("open-workspace", async () => {
      const selected = await window.mesh.chooseWorkspaceDirectory();
      return selected === null ? undefined : window.mesh.openWorkspace({ root: selected.root });
    });
  };

  const archiveSession = async (workspaceId: string, sessionId: string): Promise<void> => {
    setBusy(`archive-session:${sessionId}`);
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式不能删除会话，请打开 Electron 应用。");
      }
      setCatalog(await window.mesh.archiveSession({ workspaceId, sessionId }));
    } catch (caught) {
      setError(workspaceErrorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const workspaceTransitioning = isWorkspaceTransitionBusy(busy);
  const runtimeBusy = workspaceTransitioning ? undefined : busy;

  return (
    <main
      className={`shell ${leftSidebarCollapsed ? "left-sidebar-collapsed" : ""} ${workspaceTransitioning ? "workspace-transitioning" : ""}`}
      aria-busy={workspaceTransitioning}
    >
      <WorkspaceSidebar
        catalog={catalog}
        busy={busy}
        collapsed={leftSidebarCollapsed}
        onToggleCollapsed={() => setLeftSidebarCollapsed((value) => !value)}
        onOpenWorkspace={openWorkspace}
        onCreateSession={(workspaceId) => void transitionWorkspace(
          `create-session:${workspaceId}`,
          () => window.mesh.createSession({ workspaceId }),
        )}
        onSelectSession={(workspaceId, sessionId) => void transitionWorkspace(
          `select-session:${sessionId}`,
          () => window.mesh.selectSession({ workspaceId, sessionId }),
        )}
        onArchiveSession={(workspaceId, sessionId) => void archiveSession(workspaceId, sessionId)}
      />
      <section className="workspace-main">
        <Header
          snapshot={snapshot}
          catalog={catalog}
          busy={runtimeBusy}
          invoke={invoke}
          view={view}
          onViewChange={setView}
        />
        {error === undefined ? null : (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)}>关闭</button>
          </div>
        )}
        <div className={`workspace-grid ${view === "room" ? (rightSidebarCollapsed ? "right-collapsed" : "") : `${view}-mode`}`}>
          {view === "room" ? (
            <>
              <section className="chat-column">
                <MessageList snapshot={snapshot} chatEnd={chatEnd} />
                <Composer snapshot={snapshot} busy={runtimeBusy} invoke={invoke} />
              </section>
              <aside className={`right-column ${rightSidebarCollapsed ? "collapsed" : ""}`}>
                <div className="right-sidebar-heading">
                  {rightSidebarCollapsed ? null : (
                    <div>
                      <strong>会话成员</strong>
                      <span>{snapshot.agents.length + 1}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="right-sidebar-toggle"
                    title={rightSidebarCollapsed ? "展开右侧栏" : "收起右侧栏"}
                    aria-label={rightSidebarCollapsed ? "展开右侧栏" : "收起右侧栏"}
                    onClick={() => setRightSidebarCollapsed((value) => !value)}
                  >
                    <PanelRightIcon />
                  </button>
                </div>
                {rightSidebarCollapsed ? (
                  <div className="right-sidebar-rail" aria-hidden="true">
                    <UsersIcon />
                    <TaskIcon />
                  </div>
                ) : (
                  <>
                    <AgentRail snapshot={snapshot} probes={probes} busy={runtimeBusy} invoke={invoke} />
                    <section className="right-task-panel">
                      <div className="panel-tabs">
                        <button type="button" className="active">任务 <span>{snapshot.tasks.length}</span></button>
                      </div>
                      <TaskPanel snapshot={snapshot} busy={runtimeBusy} invoke={invoke} />
                    </section>
                  </>
                )}
              </aside>
            </>
          ) : view === "trajectory" ? (
            <TrajectoryView snapshot={snapshot} />
          ) : (
            <ConfigurationView
              preview={configPreview}
              probes={probes}
              busy={runtimeBusy}
              onSave={saveConfiguration}
              onReload={reloadConfiguration}
            />
          )}
        </div>
      </section>
    </main>
  );
}

interface RuntimeProps {
  readonly snapshot: RoomSnapshot;
  readonly busy: string | undefined;
  readonly invoke: (key: string, operation: () => Promise<RoomSnapshot>) => Promise<boolean>;
}

interface HeaderProps extends RuntimeProps {
  readonly catalog: WorkspaceCatalogView | undefined;
  readonly view: WorkspaceView;
  readonly onViewChange: (view: WorkspaceView) => void;
}

function Header({ snapshot, catalog, busy, invoke, view, onViewChange }: HeaderProps): React.JSX.Element {
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
      <nav className="breadcrumb view-tabs" aria-label="会话视图">
        <button
          type="button"
          className={view === "room" ? "active" : ""}
          onClick={() => onViewChange("room")}
        >对话</button>
        <button
          type="button"
          className={view === "trajectory" ? "active" : ""}
          onClick={() => onViewChange("trajectory")}
        >轨迹 <span>{snapshot.trace.length}</span></button>
        <button
          type="button"
          className={view === "configuration" ? "active" : ""}
          onClick={() => onViewChange("configuration")}
        >配置</button>
      </nav>
    </>
  );
}

interface WorkspaceSidebarProps {
  readonly catalog: WorkspaceCatalogView | undefined;
  readonly busy: string | undefined;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onOpenWorkspace: () => void;
  readonly onCreateSession: (workspaceId: string) => void;
  readonly onSelectSession: (workspaceId: string, sessionId: string) => void;
  readonly onArchiveSession: (workspaceId: string, sessionId: string) => void;
}

interface SessionActionMenuState {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly left: number;
  readonly top: number;
}

function WorkspaceSidebar({
  catalog,
  busy,
  collapsed,
  onToggleCollapsed,
  onOpenWorkspace,
  onCreateSession,
  onSelectSession,
  onArchiveSession,
}: WorkspaceSidebarProps): React.JSX.Element {
  const activeWorkspace = catalog?.workspaces.find(({ id }) => id === catalog.activeWorkspaceId);
  const createKey = activeWorkspace === undefined ? undefined : `create-session:${activeWorkspace.id}`;
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<readonly string[]>([]);
  const [expandedSessionWorkspaceIds, setExpandedSessionWorkspaceIds] = useState<readonly string[]>([]);
  const [sessionActionMenu, setSessionActionMenu] = useState<SessionActionMenuState | undefined>();
  const catalogMutationBusy = busy === "open-workspace"
    || busy?.startsWith("create-session:") === true
    || busy?.startsWith("archive-session:") === true;

  useEffect(() => {
    if (activeWorkspace === undefined || catalog === undefined) return;
    const activeIndex = activeWorkspace.sessions.findIndex(({ id }) => id === catalog.activeSessionId);
    if (activeIndex < sidebarSessionLimit) return;
    setExpandedSessionWorkspaceIds((ids) => ids.includes(activeWorkspace.id) ? ids : [...ids, activeWorkspace.id]);
  }, [activeWorkspace, catalog]);

  useEffect(() => {
    if (sessionActionMenu === undefined || catalog === undefined) return;
    const stillVisible = catalog.workspaces.some((workspace) => workspace.id === sessionActionMenu.workspaceId
      && workspace.sessions.some((session) => session.id === sessionActionMenu.sessionId));
    if (!stillVisible) setSessionActionMenu(undefined);
  }, [catalog, sessionActionMenu]);

  return (
    <aside className={`workspace-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand">
        <button
          type="button"
          className="left-sidebar-toggle"
          title={collapsed ? "展开左侧栏" : "收起左侧栏"}
          aria-label={collapsed ? "展开左侧栏" : "收起左侧栏"}
          onClick={onToggleCollapsed}
        >
          <PanelLeftIcon />
        </button>
      </div>
      <div className="sidebar-actions">
        <button
          type="button"
          className="create-session-primary"
          disabled={catalogMutationBusy || activeWorkspace === undefined || activeWorkspace.status === "missing"}
          onClick={() => activeWorkspace === undefined ? undefined : onCreateSession(activeWorkspace.id)}
        >
          <NewChatIcon />
          <span>{busy === createKey ? "正在创建…" : "新会话"}</span>
        </button>
      </div>
      {collapsed ? (
        <div className="sidebar-rail-actions">
          <button
            type="button"
            className="open-workspace"
            title="打开项目"
            aria-label="打开项目"
            disabled={catalogMutationBusy}
            onClick={onOpenWorkspace}
          ><FolderAddIcon /></button>
        </div>
      ) : <div className="sidebar-scroll">
        <section className="workspace-catalog" aria-label="工作区和会话">
          <div className="section-heading catalog-heading">
            <h2>工作区</h2>
            <div className="catalog-actions">
              <span className="count-badge">{catalog?.workspaces.length ?? 0}</span>
              <button
                type="button"
                className="open-workspace"
                title="打开项目"
                aria-label="打开项目"
                disabled={catalogMutationBusy}
                onClick={onOpenWorkspace}
              ><FolderAddIcon /></button>
            </div>
          </div>
          {catalog === undefined ? (
            <div className="catalog-empty"><strong>正在读取本地目录…</strong><p>Room 数据仍保存在本机。</p></div>
          ) : catalog.workspaces.length === 0 ? (
            <div className="catalog-empty"><strong>还没有工作区</strong><p>选择一个项目目录以创建首个 Session。</p></div>
          ) : (
            <div className="workspace-groups">
              {catalog.workspaces.map((workspace) => {
                const activeWorkspace = workspace.id === catalog.activeWorkspaceId;
                const workspaceCreateKey = `create-session:${workspace.id}`;
                const workspaceCollapsed = collapsedWorkspaceIds.includes(workspace.id);
                const sessionsExpanded = expandedSessionWorkspaceIds.includes(workspace.id);
                const visibleSessions = sessionsExpanded
                  ? workspace.sessions
                  : workspace.sessions.slice(0, sidebarSessionLimit);
                return (
                  <section
                    className={`workspace-group ${activeWorkspace ? "active" : ""} ${workspace.status} ${workspaceCollapsed ? "group-collapsed" : ""}`}
                    data-workspace-id={workspace.id}
                    key={workspace.id}
                  >
                    <div className="workspace-group-heading">
                      <button
                        type="button"
                        className="workspace-toggle"
                        aria-expanded={!workspaceCollapsed}
                        title={workspace.root}
                        onClick={() => {
                          setSessionActionMenu(undefined);
                          setCollapsedWorkspaceIds((ids) => ids.includes(workspace.id)
                            ? ids.filter((id) => id !== workspace.id)
                            : [...ids, workspace.id]);
                        }}
                      >
                        <span className="workspace-leading" aria-hidden="true">
                          <FolderIcon />
                          <ChevronRightIcon className={workspaceCollapsed ? "" : "open"} />
                        </span>
                        <span className="workspace-identity"><strong>{workspace.name}</strong></span>
                      </button>
                      <button
                        type="button"
                        className="new-session"
                        title={workspace.status === "missing" ? "项目目录不可用" : "新建 Session"}
                        aria-label={`在 ${workspace.name} 中新建 Session`}
                        disabled={catalogMutationBusy || workspace.status === "missing"}
                        onClick={() => onCreateSession(workspace.id)}
                      >{busy === workspaceCreateKey ? "…" : <PlusIcon />}</button>
                    </div>
                    {!workspaceCollapsed && workspace.status === "missing" ? (
                      <div className="workspace-warning"><i /> 项目目录缺失，历史仍保留在 MESH_HOME</div>
                    ) : null}
                    {workspaceCollapsed ? null : <div className="session-list">
                      {workspace.sessions.length === 0 ? (
                        <div className="session-empty">暂无 Session</div>
                      ) : visibleSessions.map((session) => {
                        const active = activeWorkspace && session.id === catalog.activeSessionId;
                        const selectable = workspace.status === "available" && session.status === "ok";
                        const title = displaySessionTitle(session);
                        const removable = !active && session.status === "ok" && session.messageCount === 0;
                        const menuOpen = sessionActionMenu?.sessionId === session.id;
                        return (
                          <div
                            className={`session-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${session.status}`}
                            key={session.id}
                          >
                            <button
                              type="button"
                              className={`session-item ${active ? "active" : ""} ${session.status}`}
                              data-session-id={session.id}
                              disabled={busy !== undefined || !selectable || active}
                              title={session.detail ?? title}
                              onClick={() => onSelectSession(workspace.id, session.id)}
                            >
                              <span className={`session-state ${session.status}`} aria-hidden="true" />
                              <span className="session-copy">
                                <span className="session-title-row">
                                  <strong>{title}</strong>
                                  <time>{formatSessionTime(session.updatedAt)}</time>
                                  {session.status === "ok" ? null : (
                                    <em>{session.status === "corrupt" ? "损坏" : "缺失"}</em>
                                  )}
                                </span>
                              </span>
                            </button>
                            {removable ? (
                              <button
                                type="button"
                                className="session-actions-trigger"
                                title="会话操作"
                                aria-label={`会话“${title}”的操作`}
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                                disabled={busy !== undefined}
                                onClick={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const menuWidth = 164;
                                  const menuHeight = 42;
                                  setSessionActionMenu((current) => current?.sessionId === session.id
                                    ? undefined
                                    : {
                                        workspaceId: workspace.id,
                                        sessionId: session.id,
                                        title,
                                        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
                                        top: rect.bottom + 4 + menuHeight > window.innerHeight
                                          ? rect.top - menuHeight - 4
                                          : rect.bottom + 4,
                                      });
                                }}
                              >
                                <EllipsisIcon />
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                      {workspace.sessions.length > sidebarSessionLimit ? (
                        <button
                          type="button"
                          className="session-overflow"
                          aria-expanded={sessionsExpanded}
                          onClick={() => setExpandedSessionWorkspaceIds((ids) => ids.includes(workspace.id)
                            ? ids.filter((id) => id !== workspace.id)
                            : [...ids, workspace.id])}
                        >
                          {sessionsExpanded ? "收起" : "展示更多"}
                        </button>
                      ) : null}
                    </div>}
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </div>
      }
      {collapsed ? null : <div className="sidebar-footer">
        <i aria-hidden="true" />
        <strong>本地 Room</strong>
        <span>共享上下文</span>
      </div>}
      {sessionActionMenu === undefined ? null : createPortal(
        <SessionActionMenu
          menu={sessionActionMenu}
          busy={busy === `archive-session:${sessionActionMenu.sessionId}`}
          onClose={() => setSessionActionMenu(undefined)}
          onArchive={() => {
            const { workspaceId, sessionId } = sessionActionMenu;
            setSessionActionMenu(undefined);
            onArchiveSession(workspaceId, sessionId);
          }}
        />,
        document.body,
      )}
    </aside>
  );
}

function SessionActionMenu({
  menu,
  busy,
  onClose,
  onArchive,
}: {
  readonly menu: SessionActionMenuState;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onArchive: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeFromPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".session-actions-trigger") !== null) return;
      onClose();
    };
    const closeFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const closeFromScroll = (): void => onClose();
    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("scroll", closeFromScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("scroll", closeFromScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="session-action-menu"
      role="menu"
      aria-label={`会话“${menu.title}”的操作`}
      style={{ left: menu.left, top: menu.top }}
    >
      <button type="button" role="menuitem" disabled={busy} onClick={onArchive}>
        <ArchiveIcon />
        <span>{busy ? "正在归档…" : "归档会话"}</span>
      </button>
    </div>
  );
}

interface AgentRailProps extends RuntimeProps {
  readonly probes: readonly DesktopAgentProbe[];
}

function AgentRail({ snapshot, probes, busy, invoke }: AgentRailProps): React.JSX.Element {
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

interface IconProps {
  readonly className?: string;
}

function PanelLeftIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.35" />
      <path d="M7.25 3.75v12.5" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function PanelRightIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.35" />
      <path d="M12.75 3.75v12.5" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function NewChatIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10.25 4H5.5A2.5 2.5 0 0 0 3 6.5v7A2.5 2.5 0 0 0 5.5 16h7a2.5 2.5 0 0 0 2.5-2.5V9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="m9.25 10.75.35-2.1L14.55 3.7a1.25 1.25 0 0 1 1.75 0 1.25 1.25 0 0 1 0 1.75L11.35 10.4l-2.1.35Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2.75 6.25A2.25 2.25 0 0 1 5 4h3l1.7 1.75H15A2.25 2.25 0 0 1 17.25 8v5A2.25 2.25 0 0 1 15 15.25H5A2.25 2.25 0 0 1 2.75 13V6.25Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

function FolderAddIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h2.75L9.5 5.75h5A2.5 2.5 0 0 1 17 8.25V13a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 13V6.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10 9v4M8 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m7.5 5 5 5-5 5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function EllipsisIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="10" r="1.15" fill="currentColor" />
      <circle cx="10" cy="10" r="1.15" fill="currentColor" />
      <circle cx="15" cy="10" r="1.15" fill="currentColor" />
    </svg>
  );
}

function ArchiveIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 7.25h12v7.25a1.75 1.75 0 0 1-1.75 1.75h-8.5A1.75 1.75 0 0 1 4 14.5V7.25Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M3.25 4.25h13.5v3H3.25v-3ZM8 10h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UsersIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="7.25" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.75 15c.3-2.55 1.8-4 4.5-4s4.2 1.45 4.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M12.5 5.25a2.5 2.5 0 0 1 0 4.8M13 11.2c2.4.2 3.75 1.5 4 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function TaskIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="m6 7 1 1 1.75-2M10.5 7h3.5M6 12h1M10.5 12h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function formatSessionTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed < 86_400_000) return `${String(Math.floor(elapsed / 3_600_000))} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

function displaySessionTitle(session: { readonly title: string; readonly messageCount: number }): string {
  return session.messageCount === 0 ? "新会话" : session.title;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configurationErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("changed after it was read")) {
    return "配置已被其他进程修改。请点击“重新加载”获取最新版本，再重新编辑。";
  }
  if (message.includes("already being saved")) {
    return "另一个进程正在保存配置，请稍后重试。";
  }
  return message;
}

function workspaceErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("Project directory is missing or unavailable")) {
    return `项目目录缺失或当前不可访问。${message.split(":").slice(1).join(":")}`;
  }
  if (message.includes("previous session remains active")) {
    return "无法打开所选 Session，原 Session 仍保持活动。请检查配置、Session 头文件和项目目录。";
  }
  if (message.includes("Cannot open")) {
    return `无法打开所选 Session：${message}`;
  }
  return message;
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
