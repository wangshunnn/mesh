import { useEffect, useState, type FormEvent } from "react";

import {
  Archive,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPlus,
  PanelLeft,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import * as CollapsiblePrimitive from "radix-ui/collapsible";
import * as DialogPrimitive from "radix-ui/dialog";
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
  readonly onRenameSession: (workspaceId: string, sessionId: string, title: string) => void;
  readonly onArchiveSession: (workspaceId: string, sessionId: string) => void;
  readonly onRenameWorkspace: (workspaceId: string, name: string) => void;
  readonly onRemoveWorkspace: (workspaceId: string) => void;
}

export function WorkspaceSidebar({
  catalog,
  busy,
  collapsed,
  onToggleCollapsed,
  onOpenWorkspace,
  onCreateSession,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onRenameWorkspace,
  onRemoveWorkspace,
}: WorkspaceSidebarProps): React.JSX.Element {
  const activeWorkspace = catalog?.workspaces.find(({ id }) => id === catalog.activeWorkspaceId);
  const createKey = activeWorkspace === undefined ? undefined : `create-session:${activeWorkspace.id}`;
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<readonly string[]>([]);
  const [expandedSessionWorkspaceIds, setExpandedSessionWorkspaceIds] = useState<readonly string[]>([]);
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | undefined>();
  const [openWorkspaceMenuId, setOpenWorkspaceMenuId] = useState<string | undefined>();
  const [renameTarget, setRenameTarget] = useState<{
    readonly kind: "workspace" | "session";
    readonly workspaceId: string;
    readonly sessionId?: string;
    readonly value: string;
  }>();
  const [removeTarget, setRemoveTarget] = useState<{ readonly workspaceId: string; readonly name: string }>();
  const catalogMutationBusy = busy === "open-workspace"
    || busy?.startsWith("create-session:") === true
    || busy?.startsWith("rename-session:") === true
    || busy?.startsWith("archive-session:") === true
    || busy?.startsWith("rename-workspace:") === true
    || busy?.startsWith("remove-workspace:") === true;

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
          className="create-session-primary app-no-drag"
          aria-label="新会话"
          disabled={catalogMutationBusy || activeWorkspace === undefined || activeWorkspace.status === "missing"}
          onClick={() => activeWorkspace === undefined ? undefined : onCreateSession(activeWorkspace.id)}
        >
          <SquarePen className="size-4.25" strokeWidth={1.7} />
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
          ><FolderPlus className="size-4.25" strokeWidth={1.7} /></IconButton>
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
              ><FolderPlus className="size-4.25" strokeWidth={1.7} /></IconButton>
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
                      setOpenWorkspaceMenuId(undefined);
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
                    <div className={`workspace-group-heading ${openWorkspaceMenuId === workspace.id ? "menu-open" : ""}`}>
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
                      <div className="workspace-row-actions">
                        <WorkspaceActionMenu
                          name={workspace.name}
                          open={openWorkspaceMenuId === workspace.id}
                          busy={catalogMutationBusy}
                          onOpenChange={(open) => {
                            setOpenSessionMenuId(undefined);
                            setOpenWorkspaceMenuId(open ? workspace.id : undefined);
                          }}
                          onRename={() => {
                            setOpenWorkspaceMenuId(undefined);
                            setRenameTarget({ kind: "workspace", workspaceId: workspace.id, value: workspace.name });
                          }}
                          onRemove={() => {
                            setOpenWorkspaceMenuId(undefined);
                            setRemoveTarget({ workspaceId: workspace.id, name: workspace.name });
                          }}
                        />
                        <IconButton
                          className="new-session"
                          label={workspace.status === "missing" ? "项目目录不可用" : `在 ${workspace.name} 中新建 Session`}
                          disabled={catalogMutationBusy || workspace.status === "missing"}
                          onClick={() => onCreateSession(workspace.id)}
                        >{busy === workspaceCreateKey ? "…" : <Plus className="size-3.75" />}</IconButton>
                      </div>
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
                        const actionable = session.status === "ok";
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
                                  {session.messageCount === 0 ? null : (
                                    <time>{formatSessionTime(session.updatedAt)}</time>
                                  )}
                                  {session.status === "ok" ? null : (
                                    <em>{session.status === "corrupt" ? "损坏" : "缺失"}</em>
                                  )}
                                </span>
                              </span>
                            </button>
                            {actionable ? (
                              <SessionActionMenu
                                title={title}
                                open={menuOpen}
                                busy={catalogMutationBusy}
                                onOpenChange={(open) => {
                                  setOpenWorkspaceMenuId(undefined);
                                  setOpenSessionMenuId(open ? session.id : undefined);
                                }}
                                onRename={() => {
                                  setOpenSessionMenuId(undefined);
                                  setRenameTarget({
                                    kind: "session",
                                    workspaceId: workspace.id,
                                    sessionId: session.id,
                                    value: title,
                                  });
                                }}
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
      <RenameDialog
        target={renameTarget}
        busy={catalogMutationBusy}
        onClose={() => setRenameTarget(undefined)}
        onSubmit={(value) => {
          const target = renameTarget;
          if (target === undefined) return;
          setRenameTarget(undefined);
          if (target.kind === "workspace") onRenameWorkspace(target.workspaceId, value);
          else if (target.sessionId !== undefined) onRenameSession(target.workspaceId, target.sessionId, value);
        }}
      />
      <RemoveWorkspaceDialog
        target={removeTarget}
        busy={catalogMutationBusy}
        onClose={() => setRemoveTarget(undefined)}
        onConfirm={() => {
          const target = removeTarget;
          if (target === undefined) return;
          setRemoveTarget(undefined);
          onRemoveWorkspace(target.workspaceId);
        }}
      />
    </aside>
  );
}
function SessionActionMenu({
  title,
  open,
  busy,
  onOpenChange,
  onRename,
  onArchive,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRename: () => void;
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
          className="session-action-menu relative! left-auto! top-auto! z-100 w-41 rounded-popover border border-line bg-white p-1 shadow-popover"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          aria-label={`会话“${title}”的操作`}
          data-ui="session-action-menu"
        >
          <DropdownMenuPrimitive.Item
            disabled={busy}
            onSelect={onRename}
            className="flex h-8.5 select-none items-center gap-2 rounded-control px-2 text-[13px] text-foreground-soft outline-none data-disabled:opacity-40 data-highlighted:bg-subtle data-highlighted:text-foreground"
          >
            <Pencil className="size-4 text-muted" />
            <span>重命名</span>
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            disabled={busy}
            onSelect={onArchive}
            className="flex h-8.5 select-none items-center gap-2 rounded-control px-2 text-[13px] text-foreground-soft outline-none data-disabled:opacity-40 data-highlighted:bg-subtle data-highlighted:text-foreground"
          >
            <Archive className="size-4 text-muted" />
            <span>归档会话</span>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function WorkspaceActionMenu({
  name,
  open,
  busy,
  onOpenChange,
  onRename,
  onRemove,
}: {
  readonly name: string;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        <IconButton className="workspace-actions-trigger" label={`工作区“${name}”的操作`} disabled={busy}>
          <Ellipsis className="size-4" />
        </IconButton>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="workspace-action-menu z-100 w-41 rounded-popover border border-line bg-white p-1 shadow-popover"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          aria-label={`工作区“${name}”的操作`}
          data-ui="workspace-action-menu"
        >
          <DropdownMenuPrimitive.Item
            disabled={busy}
            onSelect={onRename}
            className="flex h-8.5 select-none items-center gap-2 rounded-control px-2 text-[13px] text-foreground-soft outline-none data-disabled:opacity-40 data-highlighted:bg-subtle data-highlighted:text-foreground"
          >
            <Pencil className="size-4 text-muted" />
            <span>重命名</span>
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            disabled={busy}
            onSelect={onRemove}
            className="flex h-8.5 select-none items-center gap-2 rounded-control px-2 text-[13px] text-danger outline-none data-disabled:opacity-40 data-highlighted:bg-[#fff0f0]"
          >
            <Trash2 className="size-4" />
            <span>移除工作区</span>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function RenameDialog({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  readonly target: { readonly kind: "workspace" | "session"; readonly value: string } | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (value: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  useEffect(() => setValue(target?.value ?? ""), [target]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const normalized = value.trim();
    if (normalized.length > 0 && !busy) onSubmit(normalized);
  };
  const label = target?.kind === "workspace" ? "重命名工作区" : "重命名会话";
  return (
    <DialogPrimitive.Root open={target !== undefined} onOpenChange={(open) => open ? undefined : onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-dialog-overlay" />
        <DialogPrimitive.Content className="sidebar-dialog" aria-describedby={undefined} data-ui="rename-dialog">
          <div className="sidebar-dialog-heading">
            <DialogPrimitive.Title>{label}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭"><X className="size-4" /></IconButton>
            </DialogPrimitive.Close>
          </div>
          <form onSubmit={submit}>
            <input
              autoFocus
              aria-label={label}
              value={value}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="sidebar-dialog-actions">
              <DialogPrimitive.Close asChild><button type="button" className="dialog-button secondary">取消</button></DialogPrimitive.Close>
              <button type="submit" className="dialog-button primary" disabled={busy || value.trim().length === 0}>重命名</button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function RemoveWorkspaceDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  readonly target: { readonly name: string } | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={target !== undefined} onOpenChange={(open) => open ? undefined : onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-dialog-overlay" />
        <DialogPrimitive.Content className="sidebar-dialog" data-ui="remove-workspace-dialog">
          <div className="sidebar-dialog-heading">
            <DialogPrimitive.Title>移除工作区</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭"><X className="size-4" /></IconButton>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description>
            这会从工作区列表中移除“{target?.name ?? ""}”。项目目录和所有 Room 历史都会保留；再次打开同一目录即可恢复。
          </DialogPrimitive.Description>
          <div className="sidebar-dialog-actions">
            <DialogPrimitive.Close asChild><button type="button" className="dialog-button secondary">取消</button></DialogPrimitive.Close>
            <button type="button" className="dialog-button danger" disabled={busy} onClick={onConfirm}>移除工作区</button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
