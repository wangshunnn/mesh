import { useEffect, useState } from "react";

import {
  Archive,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPlus,
  PanelLeft,
  Plus,
  SquarePen,
} from "lucide-react";
import * as CollapsiblePrimitive from "radix-ui/collapsible";
import * as DropdownMenuPrimitive from "radix-ui/dropdown-menu";

import type { WorkspaceCatalogView } from "@ai-mesh/application";

import { displaySessionTitle, formatSessionTime } from "./format.js";
import { IconButton } from "./ui/controls.js";

const sidebarSessionLimit = 5;

export interface WorkspaceSidebarProps {
  readonly catalog: WorkspaceCatalogView | undefined;
  readonly busy: string | undefined;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onOpenWorkspace: () => void;
  readonly onCreateSession: (workspaceId: string) => void;
  readonly onSelectSession: (workspaceId: string, sessionId: string) => void;
  readonly onArchiveSession: (workspaceId: string, sessionId: string) => void;
}

export function WorkspaceSidebar({
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
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | undefined>();
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
    if (openSessionMenuId === undefined || catalog === undefined) return;
    const stillVisible = catalog.workspaces.some((workspace) =>
      workspace.sessions.some((session) => session.id === openSessionMenuId));
    if (!stillVisible) setOpenSessionMenuId(undefined);
  }, [catalog, openSessionMenuId]);

  return (
    <aside
      className={`workspace-sidebar ${collapsed ? "collapsed" : ""}`}
      data-ui="workspace-sidebar"
      data-state={collapsed ? "collapsed" : "expanded"}
    >
      <div className="sidebar-brand">
        <IconButton
          className="left-sidebar-toggle"
          label={collapsed ? "展开左侧栏" : "收起左侧栏"}
          onClick={onToggleCollapsed}
        >
          <PanelLeft className="size-4" strokeWidth={1.7} />
        </IconButton>
      </div>
      <div className="sidebar-actions">
        <button
          type="button"
          className="create-session-primary"
          disabled={catalogMutationBusy || activeWorkspace === undefined || activeWorkspace.status === "missing"}
          onClick={() => activeWorkspace === undefined ? undefined : onCreateSession(activeWorkspace.id)}
        >
          <SquarePen className="size-[17px]" strokeWidth={1.7} />
          <span>{busy === createKey ? "正在创建…" : "新会话"}</span>
        </button>
      </div>
      {collapsed ? (
        <div className="sidebar-rail-actions">
          <IconButton
            className="open-workspace"
            label="打开项目"
            disabled={catalogMutationBusy}
            onClick={onOpenWorkspace}
          ><FolderPlus className="size-[17px]" strokeWidth={1.7} /></IconButton>
        </div>
      ) : <div className="sidebar-scroll">
        <section className="workspace-catalog" aria-label="工作区和会话">
          <div className="section-heading catalog-heading">
            <h2>工作区</h2>
            <div className="catalog-actions">
              <span className="count-badge">{catalog?.workspaces.length ?? 0}</span>
              <IconButton
                className="open-workspace"
                label="打开项目"
                disabled={catalogMutationBusy}
                onClick={onOpenWorkspace}
              ><FolderPlus className="size-[17px]" strokeWidth={1.7} /></IconButton>
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
                  <CollapsiblePrimitive.Root
                    asChild
                    open={!workspaceCollapsed}
                    onOpenChange={(open) => {
                      setOpenSessionMenuId(undefined);
                      setCollapsedWorkspaceIds((ids) => open
                        ? ids.filter((id) => id !== workspace.id)
                        : ids.includes(workspace.id) ? ids : [...ids, workspace.id]);
                    }}
                    key={workspace.id}
                  >
                  <section
                    className={`workspace-group ${activeWorkspace ? "active" : ""} ${workspace.status} ${workspaceCollapsed ? "group-collapsed" : ""}`}
                    data-workspace-id={workspace.id}
                    data-ui="workspace-group"
                  >
                    <div className="workspace-group-heading">
                      <CollapsiblePrimitive.Trigger asChild>
                      <button
                        type="button"
                        className="workspace-toggle"
                        aria-expanded={!workspaceCollapsed}
                        title={workspace.root}
                      >
                        <span className="workspace-leading" aria-hidden="true">
                          <Folder className="folder-glyph" strokeWidth={1.7} />
                          <ChevronRight className={workspaceCollapsed ? "chevron-glyph" : "chevron-glyph open"} strokeWidth={1.8} />
                        </span>
                        <span className="workspace-identity"><strong>{workspace.name}</strong></span>
                      </button>
                      </CollapsiblePrimitive.Trigger>
                      <IconButton
                        className="new-session"
                        label={workspace.status === "missing" ? "项目目录不可用" : `在 ${workspace.name} 中新建 Session`}
                        disabled={catalogMutationBusy || workspace.status === "missing"}
                        onClick={() => onCreateSession(workspace.id)}
                      >{busy === workspaceCreateKey ? "…" : <Plus className="size-[15px]" />}</IconButton>
                    </div>
                    {!workspaceCollapsed && workspace.status === "missing" ? (
                      <div className="workspace-warning"><i /> 项目目录缺失，历史仍保留在 MESH_HOME</div>
                    ) : null}
                    <CollapsiblePrimitive.Content className="session-list">
                      {workspace.sessions.length === 0 ? (
                        <div className="session-empty">暂无 Session</div>
                      ) : visibleSessions.map((session) => {
                        const active = activeWorkspace && session.id === catalog.activeSessionId;
                        const selectable = workspace.status === "available" && session.status === "ok";
                        const title = displaySessionTitle(session);
                        const removable = !active && session.status === "ok" && session.messageCount === 0;
                        const menuOpen = openSessionMenuId === session.id;
                        return (
                          <div
                            className={`session-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${session.status}`}
                            key={session.id}
                          >
                            <button
                              type="button"
                              className={`session-item ${active ? "active" : ""} ${session.status}`}
                              data-session-id={session.id}
                              data-ui="session-item"
                              aria-current={active ? "page" : undefined}
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
                              <SessionActionMenu
                                title={title}
                                open={menuOpen}
                                busy={busy === `archive-session:${session.id}`}
                                onOpenChange={(open) => setOpenSessionMenuId(open ? session.id : undefined)}
                                onArchive={() => {
                                  setOpenSessionMenuId(undefined);
                                  onArchiveSession(workspace.id, session.id);
                                }}
                              />
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
                    </CollapsiblePrimitive.Content>
                  </section>
                  </CollapsiblePrimitive.Root>
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
    </aside>
  );
}
function SessionActionMenu({
  title,
  open,
  busy,
  onOpenChange,
  onArchive,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onArchive: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        <IconButton
          className="session-actions-trigger"
          label={`会话“${title}”的操作`}
          disabled={busy}
        >
          <Ellipsis className="size-4" />
        </IconButton>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="session-action-menu !relative !left-auto !top-auto z-[100] w-[164px] rounded-popover border border-line bg-white p-1 shadow-popover"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          aria-label={`会话“${title}”的操作`}
          data-ui="session-action-menu"
        >
          <DropdownMenuPrimitive.Item
            disabled={busy}
            onSelect={onArchive}
            className="flex h-[34px] select-none items-center gap-2 rounded-control px-2 text-[13px] text-foreground-soft outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-subtle data-[highlighted]:text-foreground"
          >
            <Archive className="size-4 text-muted" />
            <span>{busy ? "正在归档…" : "归档会话"}</span>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
