import { useEffect, useRef, useState } from "react";

import {
  ListTodo,
  PanelRight,
  Users,
} from "lucide-react";

import type {
  RoomSnapshot,
  WorkspaceCatalogView,
  WorkspaceConfigPreview,
  WorkspaceConfigSaveInput,
  WorkspaceConfigWriteResult,
  WorkspaceSelectionView,
} from "@ai-mesh/application";

import type { DesktopAgentProbe } from "../shared/api.js";
import { ConfigurationView } from "./ConfigurationView.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { AgentRail, Composer, Header, MessageList, TaskPanel, type WorkspaceView } from "./RoomWorkspace.js";
import { TrajectoryView } from "./TrajectoryView.js";
import { emptySnapshot, previewCatalog, previewConfig, previewSnapshot } from "./preview.js";
import { IconButton } from "./ui/controls.js";

function isWorkspaceTransitionBusy(busy: string | undefined): boolean {
  return busy === "open-workspace"
    || busy?.startsWith("create-session:") === true
    || busy?.startsWith("select-session:") === true
    || busy?.startsWith("archive-session:") === true
    || busy?.startsWith("remove-workspace:") === true;
}

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

  const mutateCatalog = async (
    key: string,
    operation: () => Promise<WorkspaceCatalogView>,
  ): Promise<void> => {
    setBusy(key);
    setError(undefined);
    try {
      if (window.mesh === undefined) {
        throw new Error("预览模式不能修改工作区目录，请打开 Electron 应用。");
      }
      setCatalog(await operation());
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
      data-ui="app-shell"
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
        onRenameSession={(workspaceId, sessionId, title) => void mutateCatalog(
          `rename-session:${sessionId}`,
          () => window.mesh.renameSession({ workspaceId, sessionId, title }),
        )}
        onArchiveSession={(workspaceId, sessionId) => void transitionWorkspace(
          `archive-session:${sessionId}`,
          () => window.mesh.archiveSession({ workspaceId, sessionId }),
        )}
        onRenameWorkspace={(workspaceId, name) => void mutateCatalog(
          `rename-workspace:${workspaceId}`,
          () => window.mesh.renameWorkspace({ workspaceId, name }),
        )}
        onRemoveWorkspace={(workspaceId) => void transitionWorkspace(
          `remove-workspace:${workspaceId}`,
          () => window.mesh.removeWorkspace({ workspaceId }),
        )}
      />
      <section className="workspace-main" data-ui="workspace-main">
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
        <div
          className={`workspace-grid ${view === "room" ? (rightSidebarCollapsed ? "right-collapsed" : "") : `${view}-mode`}`}
          data-ui="workspace-grid"
          data-right-state={rightSidebarCollapsed ? "collapsed" : "expanded"}
        >
          {view === "room" ? (
            <>
              <section className="chat-column" data-ui="chat-column">
                <MessageList snapshot={snapshot} chatEnd={chatEnd} />
                <Composer snapshot={snapshot} busy={runtimeBusy} invoke={invoke} />
              </section>
              <aside
                className={`right-column ${rightSidebarCollapsed ? "collapsed" : ""}`}
                data-ui="right-sidebar"
                data-state={rightSidebarCollapsed ? "collapsed" : "expanded"}
              >
                <div className="right-sidebar-heading">
                  {rightSidebarCollapsed ? null : (
                    <div>
                      <strong>会话成员</strong>
                      <span>{snapshot.agents.length + 1}</span>
                    </div>
                  )}
                  <IconButton
                    className="right-sidebar-toggle"
                    label={rightSidebarCollapsed ? "展开右侧栏" : "收起右侧栏"}
                    onClick={() => setRightSidebarCollapsed((value) => !value)}
                  >
                    <PanelRight className="size-4" strokeWidth={1.7} />
                  </IconButton>
                </div>
                {rightSidebarCollapsed ? (
                  <div className="right-sidebar-rail" aria-hidden="true">
                    <Users className="size-[17px]" />
                    <ListTodo className="size-[17px]" />
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
