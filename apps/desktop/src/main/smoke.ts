import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app } from "electron";
import { WorkspaceAdapterRegistry } from "@ai-mesh/workspace";

import { registerDesktopIpc } from "./ipc.js";
import { DesktopWorkspaceHost } from "./workspace-host.js";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "mesh-electron-smoke-"));
const root = join(fixtureDirectory, "project");
const secondRoot = join(fixtureDirectory, "another-project");
const meshHome = join(fixtureDirectory, "mesh-home");
mkdirSync(root);
mkdirSync(secondRoot);
const canonicalSecondRoot = realpathSync(secondRoot);
const screenshotDirectory = process.env.MESH_SMOKE_SCREENSHOT_DIR;
const rendererErrors: string[] = [];
const startedAgentIds = new Set<string>();
let nextSmokeSession = 1;
let workspaceHost: DesktopWorkspaceHost | undefined;
let window: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;
let exitCode = 1;
const deadline = setTimeout(() => {
  console.error("Electron smoke timed out after 25 seconds.");
  app.exit(1);
}, 25_000);

try {
  void app
    .whenReady()
    .then(runSmoke)
    .catch((error: unknown) => finishWithError(error));
} catch (error) {
  finishWithError(error);
}

async function runSmoke(): Promise<void> {
  try {
    console.log("Electron smoke: app ready.");
    workspaceHost = DesktopWorkspaceHost.open(root, {
      meshHome,
      adapterRegistry: smokeAdapterRegistry(),
    });
    unregisterIpc = registerDesktopIpc(workspaceHost, {
      chooseWorkspaceDirectory: async () => secondRoot,
    });

    window = new BrowserWindow({
      show: false,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload-bundle/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        rendererErrors.push(`${event.level}: ${event.message}`);
      }
    });
    window.webContents.on("did-fail-load", (_event, code, description) => {
      rendererErrors.push(`load ${String(code)}: ${description}`);
    });
    console.log("Electron smoke: loading renderer.");
    await window.loadFile(join(import.meta.dirname, "../../renderer/index.html"));
    console.log("Electron smoke: renderer loaded.");
    const result = (await window.webContents.executeJavaScript(
      `(async () => {
        const deadline = Date.now() + 3000;
        while (document.querySelector('[data-ui="app-shell"]') === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (window.mesh === undefined) throw new Error("preload bridge is missing");
        const snapshot = await window.mesh.snapshot();
        const config = await window.mesh.configPreview();
        const configButton = [...document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]')].find(
          (button) => button.textContent?.trim() === "配置"
        );
        if (!(configButton instanceof HTMLButtonElement)) throw new Error("config navigation is missing");
        configButton.click();
        const renderDeadline = Date.now() + 1000;
        while (document.querySelector('[data-ui="configuration-view"]') === null && Date.now() < renderDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const nameInput = document.querySelector(".configuration-agent-form input");
        const saveButton = document.querySelector(".configuration-save");
        if (!(nameInput instanceof HTMLInputElement)) throw new Error("configuration name input is missing");
        if (!(saveButton instanceof HTMLButtonElement)) throw new Error("configuration save button is missing");
        const configSelect = document.querySelector('[aria-label$="适配器"]');
        const configSwitch = document.querySelector('[role="switch"]');
        if (!(configSelect instanceof HTMLButtonElement) || configSelect.getAttribute("role") !== "combobox") {
          throw new Error("Radix configuration select is missing");
        }
        if (!(configSwitch instanceof HTMLButtonElement) || configSwitch.getAttribute("aria-checked") === null) {
          throw new Error("Radix configuration switch is missing");
        }
        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setInputValue === undefined) throw new Error("input value setter is missing");
        setInputValue.call(nameInput, "OpenCode Smoke");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        const editDeadline = Date.now() + 1000;
        while (saveButton.disabled && Date.now() < editDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (saveButton.disabled) throw new Error("configuration save did not become available");
        saveButton.click();
        let savedConfig = config;
        const saveDeadline = Date.now() + 5000;
        while (Date.now() < saveDeadline) {
          savedConfig = await window.mesh.configPreview();
          if (savedConfig.config.agents[0]?.name === "OpenCode Smoke") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const reloadedSnapshot = await window.mesh.snapshot();
        return {
          roomId: reloadedSnapshot.roomId,
          agentCount: reloadedSnapshot.agents.length,
          runningAgentCount: reloadedSnapshot.agents.filter((agent) => agent.state !== "offline" && agent.state !== "error").length,
          configRoomId: config.config.roomId,
          configSource: config.source,
          savedConfigSource: savedConfig.source,
          savedConfigRevision: savedConfig.revision,
          savedAgentName: savedConfig.config.agents[0]?.name ?? "",
          configEditable: document.querySelector(".editable-pill") !== null,
          configRendered: document.querySelector('[data-ui="configuration-view"]') !== null,
          rendered: document.querySelector('[data-ui="app-shell"]') !== null,
          radixSelectRendered: configSelect.getAttribute("role") === "combobox",
          radixSwitchRendered: configSwitch.getAttribute("role") === "switch",
          radixTabsRendered: document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]').length === 3,
          errorBanner: document.querySelector(".error-banner")?.textContent ?? ""
        };
      })()`,
      true,
    )) as {
      readonly roomId: string;
      readonly agentCount: number;
      readonly runningAgentCount: number;
      readonly configRoomId: string;
      readonly configSource: string;
      readonly savedConfigSource: string;
      readonly savedConfigRevision: string | null;
      readonly savedAgentName: string;
      readonly configEditable: boolean;
      readonly configRendered: boolean;
      readonly rendered: boolean;
      readonly radixSelectRendered: boolean;
      readonly radixSwitchRendered: boolean;
      readonly radixTabsRendered: boolean;
      readonly errorBanner: string;
    };
    if (
      !result.rendered ||
      !result.configRendered ||
      !result.configEditable ||
      !result.radixSelectRendered ||
      !result.radixSwitchRendered ||
      !result.radixTabsRendered ||
      result.roomId !== "room:main" ||
      result.configRoomId !== "room:main" ||
      result.configSource !== "default" ||
      result.savedConfigSource !== "file" ||
      result.savedConfigRevision === null ||
      result.savedAgentName !== "OpenCode Smoke" ||
      result.agentCount !== 2 ||
      result.runningAgentCount !== 0 ||
      startedAgentCount() !== 0
    ) {
      throw new Error(`Unexpected desktop state: ${JSON.stringify(result)}`);
    }
    if (result.errorBanner.length > 0 || rendererErrors.length > 0) {
      throw new Error(
        `Renderer diagnostics: ${[result.errorBanner, ...rendererErrors].filter(Boolean).join(" | ")}`,
      );
    }
    const navigation = (await window.webContents.executeJavaScript(
      `(async () => {
        const waitFor = async (predicate, message, timeout = 4000) => {
          const deadline = Date.now() + timeout;
          while (!predicate() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (!predicate()) throw new Error(message);
        };
        const initialCatalog = await window.mesh.workspaceCatalog();
        const firstWorkspaceId = initialCatalog.activeWorkspaceId;
        const firstSessionId = initialCatalog.activeSessionId;
        await window.mesh.postMessage({ text: "First smoke Room history" });
        let firstMessageSnapshot = await window.mesh.snapshot();
        const firstMessageDeadline = Date.now() + 4000;
        while (
          firstMessageSnapshot.agents.filter((agent) => agent.state !== "offline" && agent.state !== "error").length !== 2
          && Date.now() < firstMessageDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          firstMessageSnapshot = await window.mesh.snapshot();
        }
        const messageStartedAgentCount = firstMessageSnapshot.agents
          .filter((agent) => agent.state !== "offline" && agent.state !== "error").length;

        const newSessionButton = document.querySelector(
          '[data-workspace-id="' + firstWorkspaceId + '"] .new-session'
        );
        if (!(newSessionButton instanceof HTMLButtonElement)) throw new Error("new session action is missing");
        newSessionButton.click();
        await waitFor(
          () => {
            const active = document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id');
            return active !== null && active !== undefined && active !== firstSessionId;
          },
          "new session did not become active"
        );
        const createdCatalog = await window.mesh.workspaceCatalog();
        const secondSessionId = createdCatalog.activeSessionId;
        const newSnapshot = await window.mesh.snapshot();
        await window.mesh.postMessage({ text: "Second smoke Room history" });

        newSessionButton.click();
        await waitFor(
          () => {
            const active = document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id');
            return active !== null && active !== secondSessionId;
          },
          "third blank session did not become active"
        );
        const blankCreatedCatalog = await window.mesh.workspaceCatalog();
        const blankSessionId = blankCreatedCatalog.activeSessionId;
        const repeatNewSessionButton = document.querySelector(
          '[data-workspace-id="' + firstWorkspaceId + '"] .new-session'
        );
        if (!(repeatNewSessionButton instanceof HTMLButtonElement)) throw new Error("repeat new session action is missing");
        await waitFor(() => !repeatNewSessionButton.disabled, "repeat new session action stayed disabled");
        repeatNewSessionButton.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const blankReusedCatalog = await window.mesh.workspaceCatalog();
        const blankReusedCount = blankReusedCatalog.workspaces.find(
          (item) => item.id === firstWorkspaceId
        )?.sessions.length ?? 0;
        const blankCreatedCount = blankCreatedCatalog.workspaces.find(
          (item) => item.id === firstWorkspaceId
        )?.sessions.length ?? 0;
        const blankSessionActionAvailable = document.querySelector(
          '[data-session-id="' + blankSessionId + '"]'
        )?.closest('.session-row')?.querySelector('.session-actions-trigger') instanceof HTMLButtonElement;

        await window.mesh.postMessage({ text: "Third smoke Room history" });
        let previousSessionId = blankSessionId;
        for (let index = 0; index < 3; index += 1) {
          const overflowNewSessionButton = document.querySelector(
            '[data-workspace-id="' + firstWorkspaceId + '"] .new-session'
          );
          if (!(overflowNewSessionButton instanceof HTMLButtonElement)) throw new Error("overflow new session action is missing");
          await waitFor(() => !overflowNewSessionButton.disabled, "overflow new session action stayed disabled");
          overflowNewSessionButton.click();
          await waitFor(
            () => {
              const active = document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id');
              return active !== null && active !== previousSessionId;
            },
            "overflow session did not become active"
          );
          previousSessionId = (await window.mesh.workspaceCatalog()).activeSessionId;
          if (index < 2) {
            await window.mesh.postMessage({ text: "Overflow smoke Room history " + String(index + 1) });
          }
        }
        const overflowCatalog = await window.mesh.workspaceCatalog();
        const overflowSessionId = overflowCatalog.activeSessionId;
        await waitFor(
          () => document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id') === overflowSessionId,
          "overflow session did not become active"
        );
        const firstWorkspaceGroup = document.querySelector('[data-workspace-id="' + firstWorkspaceId + '"]');
        if (!(firstWorkspaceGroup instanceof HTMLElement)) throw new Error("first workspace group is missing");
        const visibleBeforeExpand = firstWorkspaceGroup.querySelectorAll('.session-item').length;
        const overflowButtonLabel = firstWorkspaceGroup.querySelector('.session-overflow')?.textContent?.trim() ?? "";
        const projectToggle = firstWorkspaceGroup.querySelector('.workspace-toggle');
        if (!(projectToggle instanceof HTMLButtonElement)) throw new Error("project collapse action is missing");
        projectToggle.click();
        await waitFor(() => firstWorkspaceGroup.getAttribute('data-state') === 'closed', "project did not collapse");
        const collapsedProjectSessions = firstWorkspaceGroup.querySelectorAll('.session-item').length;
        projectToggle.click();
        await waitFor(() => firstWorkspaceGroup.getAttribute('data-state') === 'open', "project did not expand");
        const overflowButton = firstWorkspaceGroup.querySelector('.session-overflow');
        if (!(overflowButton instanceof HTMLButtonElement)) throw new Error("session overflow action is missing");
        overflowButton.click();
        await waitFor(
          () => firstWorkspaceGroup.querySelector('[data-session-id="' + firstSessionId + '"]') !== null,
          "session overflow did not expand"
        );

        const firstSessionButton = document.querySelector('[data-session-id="' + firstSessionId + '"]');
        if (!(firstSessionButton instanceof HTMLButtonElement)) throw new Error("first session action is missing");
        firstSessionButton.click();
        await waitFor(
          () => document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id') === firstSessionId,
          "first session did not become active"
        );
        const returnedCatalog = await window.mesh.workspaceCatalog();
        const returnedSnapshot = await window.mesh.snapshot();
        const activeSessionRow = document.querySelector(
          '[data-session-id="' + firstSessionId + '"]'
        )?.closest('.session-row');
        const activeSessionButton = activeSessionRow?.querySelector('.session-actions-trigger');
        if (!(activeSessionButton instanceof HTMLButtonElement)) throw new Error("active session actions trigger is missing");
        activeSessionButton.focus();
        activeSessionButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await waitFor(() => document.querySelector('[data-ui="session-action-menu"]') !== null, "keyboard did not open session actions menu");
        const sessionMenuItemLabels = [...document.querySelectorAll('[data-ui="session-action-menu"] [role="menuitem"]')]
          .map((item) => item.textContent?.trim() ?? "");
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await waitFor(() => document.querySelector('[data-ui="session-action-menu"]') === null, "Escape did not close session actions menu");
        const sessionMenuFocusRestored = document.activeElement === activeSessionButton;
        const archivedSessionRow = document.querySelector(
          '[data-session-id="' + secondSessionId + '"]'
        )?.closest('.session-row');
        const archivedSessionButton = archivedSessionRow?.querySelector('.session-actions-trigger');
        if (!(archivedSessionButton instanceof HTMLButtonElement)) throw new Error("historical session actions trigger is missing");
        archivedSessionButton.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerType: "mouse",
        }));
        await waitFor(() => document.querySelector('[data-ui="session-action-menu"]') !== null, "session actions menu did not open");
        const archiveMenuItem = [...document.querySelectorAll('[data-ui="session-action-menu"] [role="menuitem"]')]
          .find((item) => item.textContent?.trim() === "归档会话");
        if (!(archiveMenuItem instanceof HTMLElement)) throw new Error("archive session menu item is missing");
        archiveMenuItem.click();
        await waitFor(
          () => document.querySelector('[data-session-id="' + secondSessionId + '"]') === null,
          "archived session did not leave the catalog"
        );
        const archivedCatalog = await window.mesh.workspaceCatalog();

        const leftSidebarToggle = document.querySelector('.left-sidebar-toggle');
        if (!(leftSidebarToggle instanceof HTMLButtonElement)) throw new Error("left sidebar toggle is missing");
        leftSidebarToggle.click();
        await waitFor(() => document.querySelector('[data-ui="workspace-sidebar"]')?.getAttribute('data-state') === 'collapsed', "left sidebar did not collapse");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const collapsedMainRect = document.querySelector('[data-ui="workspace-main"]')?.getBoundingClientRect();
        const collapsedGridRect = document.querySelector('[data-ui="workspace-grid"]')?.getBoundingClientRect();
        const collapsedViewportWidth = document.documentElement.clientWidth;
        const collapsedLeftWidth = collapsedMainRect?.left ?? -1;
        const collapsedMainWidth = collapsedMainRect?.width ?? 0;
        const collapsedGridWidth = collapsedGridRect?.width ?? 0;
        const collapsedSidebarOverlayWidth = document.querySelector('[data-ui="workspace-sidebar"]')?.getBoundingClientRect().width ?? 0;
        const collapsedToggleRect = leftSidebarToggle.getBoundingClientRect();
        const collapsedToggleHitTarget = document.elementFromPoint(
          collapsedToggleRect.left + collapsedToggleRect.width / 2,
          collapsedToggleRect.top + collapsedToggleRect.height / 2
        )?.closest('.left-sidebar-toggle') === leftSidebarToggle;
        const collapsedCreateSession = document.querySelector('.create-session-primary');
        const collapsedSidebar = document.querySelector('[data-ui="workspace-sidebar"]');
        const collapsedSidebarBrand = collapsedSidebar?.querySelector('.sidebar-brand');
        const collapsedSidebarActions = collapsedSidebar?.querySelector('.sidebar-actions');
        const topbar = document.querySelector('.topbar');
        const topbarDragZone = document.querySelector('[data-ui="topbar-drag-zone"]');
        if (!(collapsedCreateSession instanceof HTMLButtonElement)) throw new Error("collapsed new session action is missing");
        if (!(collapsedSidebar instanceof HTMLElement)) throw new Error("collapsed workspace sidebar is missing");
        if (!(collapsedSidebarBrand instanceof HTMLElement)) throw new Error("collapsed sidebar brand is missing");
        if (!(collapsedSidebarActions instanceof HTMLElement)) throw new Error("collapsed sidebar actions are missing");
        if (!(topbar instanceof HTMLElement)) throw new Error("topbar is missing");
        if (!(topbarDragZone instanceof HTMLElement)) throw new Error("topbar drag zone is missing");
        const collapsedCreateRect = collapsedCreateSession.getBoundingClientRect();
        const collapsedCreateHitTarget = document.elementFromPoint(
          collapsedCreateRect.left + collapsedCreateRect.width / 2,
          collapsedCreateRect.top + collapsedCreateRect.height / 2
        )?.closest('.create-session-primary') === collapsedCreateSession;
        const collapsedToggleAppRegion = getComputedStyle(leftSidebarToggle).getPropertyValue('-webkit-app-region');
        const collapsedCreateAppRegion = getComputedStyle(collapsedCreateSession).getPropertyValue('-webkit-app-region');
        const collapsedSidebarAppRegion = getComputedStyle(collapsedSidebar).getPropertyValue('-webkit-app-region');
        const collapsedCreateLabel = collapsedCreateSession.getAttribute('aria-label');
        const collapsedSidebarPointerEvents = getComputedStyle(collapsedSidebar).pointerEvents;
        const collapsedBrandPointerEvents = getComputedStyle(collapsedSidebarBrand).pointerEvents;
        const collapsedActionsPointerEvents = getComputedStyle(collapsedSidebarActions).pointerEvents;
        const topbarAppRegion = getComputedStyle(topbar).getPropertyValue('-webkit-app-region');
        const topbarDragZoneAppRegion = getComputedStyle(topbarDragZone).getPropertyValue('-webkit-app-region');
        leftSidebarToggle.click();
        await waitFor(() => document.querySelector('[data-ui="workspace-sidebar"]')?.getAttribute('data-state') === 'expanded', "left sidebar did not expand");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedLeftWidth = document.querySelector('[data-ui="workspace-sidebar"]')?.getBoundingClientRect().width ?? 0;
        const expandedToggleRect = leftSidebarToggle.getBoundingClientRect();

        const rightSidebarToggle = document.querySelector('.right-sidebar-toggle');
        if (!(rightSidebarToggle instanceof HTMLButtonElement)) throw new Error("right sidebar toggle is missing");
        rightSidebarToggle.click();
        await waitFor(() => document.querySelector('[data-ui="right-sidebar"]')?.getAttribute('data-state') === 'collapsed', "right sidebar did not collapse");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const collapsedRightSidebar = document.querySelector('[data-ui="right-sidebar"]');
        const collapsedRightWidth = collapsedRightSidebar?.getBoundingClientRect().width ?? 0;
        const collapsedRightChildCount = collapsedRightSidebar?.children.length ?? -1;
        const collapsedRightToggleRect = rightSidebarToggle.getBoundingClientRect();
        rightSidebarToggle.click();
        await waitFor(() => document.querySelector('[data-ui="right-sidebar"]')?.getAttribute('data-state') === 'expanded', "right sidebar did not expand");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedRightRect = document.querySelector('[data-ui="right-sidebar"]')?.getBoundingClientRect();
        const expandedRightWidth = expandedRightRect?.width ?? 0;
        const rightSidebarWindowAnchored = expandedRightRect?.top === 0
          && expandedRightRect.height === document.documentElement.clientHeight;
        const expandedRightToggleRect = rightSidebarToggle.getBoundingClientRect();
        const rightToggleStayedFixed = collapsedRightToggleRect.left === expandedRightToggleRect.left
          && collapsedRightToggleRect.top === expandedRightToggleRect.top;
        const rightToggleWindowAnchored = collapsedRightToggleRect.right === document.documentElement.clientWidth - 12
          && expandedRightToggleRect.right === document.documentElement.clientWidth - 12;
        const mainNavigationRect = document.querySelector('.view-tabs')?.getBoundingClientRect();
        const rightNavigationRect = document.querySelector('.right-sidebar-heading')?.getBoundingClientRect();
        const rightNavigationAligned = mainNavigationRect !== undefined
          && rightNavigationRect !== undefined
          && mainNavigationRect.height === rightNavigationRect.height
          && mainNavigationRect.bottom === rightNavigationRect.bottom;
        const rightPanelTabs = [...document.querySelectorAll('[data-ui="right-panel-tabs"] [role="tab"]')];
        const rightPanelTabLabels = rightPanelTabs.map((tab) => tab.textContent?.trim() ?? "");
        const taskTab = rightPanelTabs.find((tab) => tab.textContent?.includes("任务"));
        if (!(taskTab instanceof HTMLButtonElement)) throw new Error("task panel tab is missing");
        taskTab.click();
        await waitFor(() => document.querySelector('.right-task-panel') !== null, "task panel did not open");
        const taskPanelRendered = document.querySelector('.task-panel') !== null;
        const membersTab = [...document.querySelectorAll('[data-ui="right-panel-tabs"] [role="tab"]')]
          .find((tab) => tab.textContent?.includes("成员"));
        if (!(membersTab instanceof HTMLButtonElement)) throw new Error("member panel tab is missing");
        membersTab.click();
        await waitFor(() => document.querySelector('.agent-rail') !== null, "member panel did not open");
        const memberPanelRendered = document.querySelector('.agent-rail') !== null;
        const memberStatusDotEdges = [...document.querySelectorAll('.agent-card .status-dot')]
          .map((dot) => dot.getBoundingClientRect().right);
        const memberStatusDotsAligned = memberStatusDotEdges.length === 3
          && Math.max(...memberStatusDotEdges) - Math.min(...memberStatusDotEdges) < 0.5;
        const firstAgentAction = document.querySelector('[data-ui="agent-card"] .agent-action');
        if (!(firstAgentAction instanceof HTMLButtonElement)) throw new Error("individual Agent action is missing");
        await waitFor(() => !firstAgentAction.disabled && firstAgentAction.textContent?.trim() === "启动", "navigation unexpectedly started an Agent");
        const navigationStayedCold = firstAgentAction.textContent?.trim() === "启动";
        firstAgentAction.click();
        await waitFor(() => !firstAgentAction.disabled && firstAgentAction.textContent?.trim() === "停止", "individual Agent did not start");
        firstAgentAction.click();
        await waitFor(() => !firstAgentAction.disabled && firstAgentAction.textContent?.trim() === "启动", "individual Agent did not stop");
        const individualAgentToggleWorks = firstAgentAction.textContent?.trim() === "启动";
        const navigationHeight = (document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0)
          + (document.querySelector('.view-tabs')?.getBoundingClientRect().height ?? 0);
        const rootStyle = getComputedStyle(document.documentElement);
        const sidebarColor = getComputedStyle(document.querySelector('.workspace-sidebar')).backgroundColor;
        const sessionFontSize = parseFloat(getComputedStyle(document.querySelector('.session-title-row strong')).fontSize);
        const messageFontSize = parseFloat(getComputedStyle(document.querySelector('.message-body > p')).fontSize);

        const openWorkspaceButton = document.querySelector('.open-workspace');
        if (!(openWorkspaceButton instanceof HTMLButtonElement)) throw new Error("open project action is missing");
        openWorkspaceButton.click();
        await waitFor(
          () => document.querySelectorAll('.workspace-group').length === 2,
          "second workspace did not render"
        );
        const openedCatalog = await window.mesh.workspaceCatalog();
        const openedSnapshot = await window.mesh.snapshot();

        const originalSessionButton = document.querySelector('[data-session-id="' + firstSessionId + '"]');
        if (!(originalSessionButton instanceof HTMLButtonElement)) throw new Error("original session disappeared");
        originalSessionButton.click();
        await waitFor(
          () => document.querySelector('[data-ui="session-item"][aria-current="page"]')?.getAttribute('data-session-id') === firstSessionId,
          "original workspace session did not reactivate"
        );
        const inactiveWorkspaceGroup = [...document.querySelectorAll('.workspace-group')].find(
          (group) => group.getAttribute('data-workspace-id') !== firstWorkspaceId
        );
        const inactiveWorkspaceToggle = inactiveWorkspaceGroup?.querySelector('.workspace-toggle');
        if (!(inactiveWorkspaceToggle instanceof HTMLButtonElement)) throw new Error("inactive project toggle is missing");
        inactiveWorkspaceToggle.click();
        await waitFor(() => inactiveWorkspaceToggle.getAttribute("aria-expanded") === "false", "inactive project did not collapse");
        const inactiveWorkspaceHeading = inactiveWorkspaceToggle.closest('.workspace-group-heading');
        const inactiveWorkspaceFocusBackground = inactiveWorkspaceHeading === null
          ? "missing"
          : getComputedStyle(inactiveWorkspaceHeading).backgroundColor;
        inactiveWorkspaceToggle.click();
        await waitFor(() => inactiveWorkspaceToggle.getAttribute("aria-expanded") === "true", "inactive project did not expand");
        const inactiveWorkspaceActions = inactiveWorkspaceGroup?.querySelector('.workspace-actions-trigger');
        if (!(inactiveWorkspaceActions instanceof HTMLButtonElement)) throw new Error("workspace actions trigger is missing");
        inactiveWorkspaceActions.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerType: "mouse",
        }));
        await waitFor(() => document.querySelector('[data-ui="workspace-action-menu"]') !== null, "workspace actions menu did not open");
        const workspaceMenuItemLabels = [...document.querySelectorAll('[data-ui="workspace-action-menu"] [role="menuitem"]')]
          .map((item) => item.textContent?.trim() ?? "");
        const removeWorkspaceItem = [...document.querySelectorAll('[data-ui="workspace-action-menu"] [role="menuitem"]')]
          .find((item) => item.textContent?.trim() === "移除工作区");
        if (!(removeWorkspaceItem instanceof HTMLElement)) throw new Error("remove workspace menu item is missing");
        removeWorkspaceItem.click();
        await waitFor(() => document.querySelector('[data-ui="remove-workspace-dialog"]') !== null, "remove workspace dialog did not open");
        const workspaceRemoveRetention = document.querySelector('[data-ui="remove-workspace-dialog"]')?.textContent?.includes("项目目录和所有 Room 历史都会保留") === true;
        const confirmRemoveWorkspace = document.querySelector('[data-ui="remove-workspace-dialog"] .dialog-button.danger');
        if (!(confirmRemoveWorkspace instanceof HTMLButtonElement)) throw new Error("remove workspace confirmation is missing");
        confirmRemoveWorkspace.click();
        await waitFor(() => document.querySelectorAll('.workspace-group').length === 1, "workspace did not leave the catalog");
        const finalCatalog = await window.mesh.workspaceCatalog();
        return {
          firstWorkspaceId,
          firstSessionId,
          secondSessionId,
          blankSessionId,
          blankReusedSessionId: blankReusedCatalog.activeSessionId,
          blankCreatedCount,
          blankReusedCount,
          blankSessionActionAvailable,
          overflowSessionCount: overflowCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.length ?? 0,
          archivedSessionCount: archivedCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.length ?? 0,
          sessionMenuItemLabels,
          sessionMenuFocusRestored,
          workspaceMenuItemLabels,
          workspaceRemoveRetention,
          visibleBeforeExpand,
          overflowButtonLabel,
          collapsedProjectSessions,
          createdOrder: createdCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.map((item) => item.id) ?? [],
          returnedOrder: returnedCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.map((item) => item.id) ?? [],
          newMessageCount: newSnapshot.messages.length,
          returnedMessages: returnedSnapshot.messages.map((message) => message.text),
          openedWorkspaceCount: openedCatalog.workspaces.length,
          openedRoot: openedCatalog.workspaces.find((item) => item.id === openedCatalog.activeWorkspaceId)?.root ?? "",
          openedMessageCount: openedSnapshot.messages.length,
          finalWorkspaceId: finalCatalog.activeWorkspaceId,
          finalSessionId: finalCatalog.activeSessionId,
          collapsedLeftWidth,
          collapsedMainWidth,
          collapsedGridWidth,
          collapsedViewportWidth,
          collapsedSidebarOverlayWidth,
          collapsedToggleHitTarget,
          collapsedCreateHitTarget,
          collapsedToggleAppRegion,
          collapsedCreateAppRegion,
          collapsedSidebarAppRegion,
          collapsedCreateLabel,
          collapsedSidebarPointerEvents,
          collapsedBrandPointerEvents,
          collapsedActionsPointerEvents,
          topbarAppRegion,
          topbarDragZoneAppRegion,
          expandedLeftWidth,
          collapsedToggleLeft: collapsedToggleRect.left,
          collapsedToggleTop: collapsedToggleRect.top,
          collapsedToggleHeight: collapsedToggleRect.height,
          expandedToggleLeft: expandedToggleRect.left,
          expandedToggleTop: expandedToggleRect.top,
          collapsedRightWidth,
          collapsedRightChildCount,
          expandedRightWidth,
          rightSidebarWindowAnchored,
          rightToggleStayedFixed,
          rightToggleWindowAnchored,
          rightNavigationAligned,
          rightPanelTabLabels,
          taskPanelRendered,
          memberPanelRendered,
          memberStatusDotsAligned,
          messageStartedAgentCount,
          navigationStayedCold,
          individualAgentToggleWorks,
          navigationHeight,
          rootFontSize: rootStyle.fontSize,
          rootFontFamily: rootStyle.fontFamily,
          sidebarColor,
          sessionFontSize,
          messageFontSize,
          inactiveWorkspaceFocusBackground,
          activeSessionCount: document.querySelectorAll('[data-ui="session-item"][aria-current="page"]').length,
          renderedWorkspaceGroups: document.querySelectorAll('.workspace-group').length,
          renderedSessions: document.querySelectorAll('.session-item').length,
          sidebarRendered: document.querySelector('[data-ui="workspace-sidebar"]') !== null,
          errorBanner: document.querySelector('.error-banner')?.textContent ?? ""
        };
      })()`,
      true,
    )) as {
      readonly firstWorkspaceId: string;
      readonly firstSessionId: string;
      readonly secondSessionId: string;
      readonly blankSessionId: string;
      readonly blankReusedSessionId: string;
      readonly blankCreatedCount: number;
      readonly blankReusedCount: number;
      readonly blankSessionActionAvailable: boolean;
      readonly overflowSessionCount: number;
      readonly archivedSessionCount: number;
      readonly sessionMenuItemLabels: readonly string[];
      readonly sessionMenuFocusRestored: boolean;
      readonly workspaceMenuItemLabels: readonly string[];
      readonly workspaceRemoveRetention: boolean;
      readonly visibleBeforeExpand: number;
      readonly overflowButtonLabel: string;
      readonly collapsedProjectSessions: number;
      readonly createdOrder: readonly string[];
      readonly returnedOrder: readonly string[];
      readonly newMessageCount: number;
      readonly returnedMessages: readonly string[];
      readonly openedWorkspaceCount: number;
      readonly openedRoot: string;
      readonly openedMessageCount: number;
      readonly finalWorkspaceId: string;
      readonly finalSessionId: string;
      readonly collapsedLeftWidth: number;
      readonly collapsedMainWidth: number;
      readonly collapsedGridWidth: number;
      readonly collapsedViewportWidth: number;
      readonly collapsedSidebarOverlayWidth: number;
      readonly collapsedToggleHitTarget: boolean;
      readonly collapsedCreateHitTarget: boolean;
      readonly collapsedToggleAppRegion: string;
      readonly collapsedCreateAppRegion: string;
      readonly collapsedSidebarAppRegion: string;
      readonly collapsedCreateLabel: string | null;
      readonly collapsedSidebarPointerEvents: string;
      readonly collapsedBrandPointerEvents: string;
      readonly collapsedActionsPointerEvents: string;
      readonly topbarAppRegion: string;
      readonly topbarDragZoneAppRegion: string;
      readonly expandedLeftWidth: number;
      readonly collapsedToggleLeft: number;
      readonly collapsedToggleTop: number;
      readonly collapsedToggleHeight: number;
      readonly expandedToggleLeft: number;
      readonly expandedToggleTop: number;
      readonly collapsedRightWidth: number;
      readonly collapsedRightChildCount: number;
      readonly expandedRightWidth: number;
      readonly rightSidebarWindowAnchored: boolean;
      readonly rightToggleStayedFixed: boolean;
      readonly rightToggleWindowAnchored: boolean;
      readonly rightNavigationAligned: boolean;
      readonly rightPanelTabLabels: readonly string[];
      readonly taskPanelRendered: boolean;
      readonly memberPanelRendered: boolean;
      readonly memberStatusDotsAligned: boolean;
      readonly messageStartedAgentCount: number;
      readonly navigationStayedCold: boolean;
      readonly individualAgentToggleWorks: boolean;
      readonly navigationHeight: number;
      readonly rootFontSize: string;
      readonly rootFontFamily: string;
      readonly sidebarColor: string;
      readonly sessionFontSize: number;
      readonly messageFontSize: number;
      readonly inactiveWorkspaceFocusBackground: string;
      readonly activeSessionCount: number;
      readonly renderedWorkspaceGroups: number;
      readonly renderedSessions: number;
      readonly sidebarRendered: boolean;
      readonly errorBanner: string;
    };
    if (
      !navigation.sidebarRendered ||
      navigation.firstSessionId === navigation.secondSessionId ||
      navigation.createdOrder[0] !== navigation.secondSessionId ||
      navigation.blankSessionId !== navigation.blankReusedSessionId ||
      navigation.blankCreatedCount !== 3 ||
      navigation.blankReusedCount !== 3 ||
      !navigation.blankSessionActionAvailable ||
      navigation.overflowSessionCount !== 6 ||
      navigation.archivedSessionCount !== 5 ||
      navigation.sessionMenuItemLabels.join("|") !== "重命名|归档会话" ||
      !navigation.sessionMenuFocusRestored ||
      navigation.workspaceMenuItemLabels.join("|") !== "重命名|移除工作区" ||
      !navigation.workspaceRemoveRetention ||
      navigation.visibleBeforeExpand !== 5 ||
      navigation.overflowButtonLabel !== "展示更多" ||
      navigation.collapsedProjectSessions !== 0 ||
      navigation.returnedOrder.length !== 6 ||
      navigation.returnedOrder[5] !== navigation.firstSessionId ||
      navigation.newMessageCount !== 0 ||
      navigation.returnedMessages.length !== 1 ||
      navigation.returnedMessages[0] !== "First smoke Room history" ||
      navigation.openedWorkspaceCount !== 2 ||
      navigation.openedRoot !== canonicalSecondRoot ||
      navigation.openedMessageCount !== 0 ||
      navigation.finalWorkspaceId !== navigation.firstWorkspaceId ||
      navigation.finalSessionId !== navigation.firstSessionId ||
      navigation.collapsedLeftWidth !== 0 ||
      navigation.collapsedMainWidth + navigation.expandedRightWidth !== navigation.collapsedViewportWidth ||
      navigation.collapsedGridWidth !== navigation.collapsedMainWidth ||
      navigation.collapsedSidebarOverlayWidth !== 148 ||
      !navigation.collapsedToggleHitTarget ||
      !navigation.collapsedCreateHitTarget ||
      navigation.collapsedToggleAppRegion !== "no-drag" ||
      navigation.collapsedCreateAppRegion !== "no-drag" ||
      navigation.collapsedSidebarAppRegion !== "no-drag" ||
      navigation.collapsedCreateLabel !== "新会话" ||
      navigation.collapsedSidebarPointerEvents !== "auto" ||
      navigation.collapsedBrandPointerEvents !== "auto" ||
      navigation.collapsedActionsPointerEvents !== "auto" ||
      navigation.topbarAppRegion !== "no-drag" ||
      navigation.topbarDragZoneAppRegion !== "drag" ||
      navigation.expandedLeftWidth < 240 ||
      navigation.collapsedToggleLeft < 76 ||
      navigation.collapsedToggleLeft > 80 ||
      navigation.collapsedToggleTop < 7 ||
      navigation.collapsedToggleTop > 9 ||
      navigation.collapsedToggleHeight !== 30 ||
      navigation.expandedToggleLeft !== navigation.collapsedToggleLeft ||
      navigation.expandedToggleTop !== navigation.collapsedToggleTop ||
      navigation.collapsedRightWidth !== 0 ||
      navigation.collapsedRightChildCount !== 0 ||
      navigation.expandedRightWidth < 292 ||
      !navigation.rightSidebarWindowAnchored ||
      !navigation.rightToggleStayedFixed ||
      !navigation.rightToggleWindowAnchored ||
      !navigation.rightNavigationAligned ||
      navigation.rightPanelTabLabels.length !== 2 ||
      !navigation.rightPanelTabLabels[0]?.startsWith("成员") ||
      !navigation.rightPanelTabLabels[1]?.startsWith("任务") ||
      !navigation.taskPanelRendered ||
      !navigation.memberPanelRendered ||
      !navigation.memberStatusDotsAligned ||
      navigation.messageStartedAgentCount !== 2 ||
      !navigation.navigationStayedCold ||
      !navigation.individualAgentToggleWorks ||
      startedAgentCount() !== 2 ||
      navigation.navigationHeight > 78 ||
      navigation.rootFontSize !== "14px" ||
      !navigation.rootFontFamily.includes("-apple-system") ||
      navigation.sidebarColor !== "rgb(249, 249, 249)" ||
      navigation.sessionFontSize < 13 ||
      navigation.messageFontSize < 14 ||
      navigation.inactiveWorkspaceFocusBackground !== "rgba(0, 0, 0, 0)" ||
      navigation.activeSessionCount !== 1 ||
      navigation.renderedWorkspaceGroups !== 1 ||
      navigation.renderedSessions !== 5 ||
      navigation.errorBanner.length > 0
    ) {
      throw new Error(`Unexpected workspace navigation state: ${JSON.stringify(navigation)}`);
    }
    const storage = await workspaceHost.run((activeWorkspace) => activeWorkspace.configPreview());
    if (
      !storage.dataDirectory.startsWith(join(meshHome, "sessions", storage.projectKey)) ||
      storage.dataDirectory !== storage.sessionDirectory ||
      !existsSync(storage.headerPath) ||
      !existsSync(storage.registryPath) ||
      existsSync(join(meshHome, "workspaces")) ||
      existsSync(join(root, ".mesh"))
    ) {
      throw new Error(`Workspace session data was not centralized: ${JSON.stringify(storage)}`);
    }
    const layouts = [];
    for (const size of [{ width: 1440, height: 900 }, { width: 1040, height: 680 }]) {
      window.setContentSize(size.width, size.height);
      const layout = (await window.webContents.executeJavaScript(
        `(async () => {
          const deadline = Date.now() + 1000;
          while ((window.innerWidth !== ${String(size.width)} || window.innerHeight !== ${String(size.height)}) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          const roomButton = [...document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]')].find(
            (button) => button.textContent?.trim() === "对话"
          );
          if (!(roomButton instanceof HTMLButtonElement)) throw new Error("room navigation is missing");
          roomButton.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebar = document.querySelector('[data-ui="workspace-sidebar"]');
          const main = document.querySelector('[data-ui="workspace-main"]');
          const grid = document.querySelector('[data-ui="workspace-grid"]');
          const sessionItems = [...document.querySelectorAll('[data-ui="session-item"]')];
          const roomLayout = {
            sidebarOverflow: sidebar === null ? true : sidebar.scrollWidth > sidebar.clientWidth,
            mainOverflow: main === null ? true : main.scrollWidth > main.clientWidth,
            gridOverflow: grid === null ? true : grid.scrollWidth > grid.clientWidth,
            minimumSessionWidth: sessionItems.length === 0 ? 0 : Math.min(...sessionItems.map((item) => item.getBoundingClientRect().width)),
            sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
            rightSidebarWidth: document.querySelector('[data-ui="right-sidebar"]')?.getBoundingClientRect().width ?? 0,
            chatWidth: document.querySelector('[data-ui="chat-column"]')?.getBoundingClientRect().width ?? 0
          };
          const leftSidebarToggle = document.querySelector(".left-sidebar-toggle");
          if (!(leftSidebarToggle instanceof HTMLButtonElement)) throw new Error("left sidebar toggle is missing");
          leftSidebarToggle.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const collapsedMain = document.querySelector('[data-ui="workspace-main"]');
          const collapsedGrid = document.querySelector('[data-ui="workspace-grid"]');
          const collapsedRoomLayout = {
            collapsedSidebarActive: document.querySelector('[data-ui="workspace-sidebar"]')?.getAttribute('data-state') === 'collapsed',
            collapsedDocumentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            collapsedMainLeft: collapsedMain?.getBoundingClientRect().left ?? -1,
            collapsedMainWidth: collapsedMain?.getBoundingClientRect().width ?? 0,
            collapsedGridWidth: collapsedGrid?.getBoundingClientRect().width ?? 0,
            collapsedRightSidebarWidth: document.querySelector('[data-ui="right-sidebar"]')?.getBoundingClientRect().width ?? 0,
            collapsedChatWidth: document.querySelector('[data-ui="chat-column"]')?.getBoundingClientRect().width ?? 0
          };
          leftSidebarToggle.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const configButton = [...document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]')].find(
            (button) => button.textContent?.trim() === "配置"
          );
          if (!(configButton instanceof HTMLButtonElement)) throw new Error("config navigation is missing");
          configButton.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const configView = document.querySelector('[data-ui="configuration-view"]');
          const configScroll = document.querySelector(".configuration-scroll");
          const cards = [...document.querySelectorAll(".configuration-agent")];
          return {
            width: window.innerWidth,
            height: window.innerHeight,
            documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            ...roomLayout,
            ...collapsedRoomLayout,
            configViewOverflow: configView === null ? true : configView.scrollWidth > configView.clientWidth,
            configScrollOverflow: configScroll === null ? true : configScroll.scrollWidth > configScroll.clientWidth,
            minimumCardWidth: cards.length === 0 ? 0 : Math.min(...cards.map((card) => card.getBoundingClientRect().width))
          };
        })()`,
        true,
      )) as {
        readonly width: number;
      readonly height: number;
      readonly documentOverflow: boolean;
      readonly sidebarOverflow: boolean;
      readonly mainOverflow: boolean;
      readonly gridOverflow: boolean;
      readonly minimumSessionWidth: number;
      readonly sidebarWidth: number;
      readonly rightSidebarWidth: number;
      readonly chatWidth: number;
      readonly collapsedSidebarActive: boolean;
      readonly collapsedDocumentOverflow: boolean;
      readonly collapsedMainLeft: number;
      readonly collapsedMainWidth: number;
      readonly collapsedGridWidth: number;
      readonly collapsedRightSidebarWidth: number;
      readonly collapsedChatWidth: number;
      readonly configViewOverflow: boolean;
      readonly configScrollOverflow: boolean;
      readonly minimumCardWidth: number;
      };
      layouts.push(layout);
      if (
        layout.width !== size.width ||
        layout.height !== size.height ||
        layout.documentOverflow ||
        layout.sidebarOverflow ||
        layout.mainOverflow ||
        layout.gridOverflow ||
        layout.minimumSessionWidth < 180 ||
        layout.sidebarWidth < 220 ||
        layout.chatWidth < 400 ||
        !layout.collapsedSidebarActive ||
        layout.collapsedDocumentOverflow ||
        layout.collapsedMainLeft !== 0 ||
        layout.collapsedMainWidth + layout.collapsedRightSidebarWidth !== layout.width ||
        layout.collapsedGridWidth !== layout.collapsedMainWidth ||
        layout.collapsedChatWidth <= layout.chatWidth ||
        layout.configViewOverflow ||
        layout.configScrollOverflow ||
        layout.minimumCardWidth < 300
      ) {
        throw new Error(`Unexpected workspace navigation layout: ${JSON.stringify(layout)}`);
      }
      if (screenshotDirectory !== undefined) {
        mkdirSync(screenshotDirectory, { recursive: true });
        const configurationScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `configuration-${String(size.width)}x${String(size.height)}.png`),
          configurationScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `(() => {
            const select = document.querySelector('[aria-label$="适配器"]');
            select?.scrollIntoView({ block: "center" });
            select?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
          })()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const selectScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `configuration-select-${String(size.width)}x${String(size.height)}.png`),
          selectScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
          true,
        );
        await window.webContents.executeJavaScript(
          `([...document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]')].find((button) => button.textContent?.includes("轨迹")))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const trajectoryScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `trajectory-${String(size.width)}x${String(size.height)}.png`),
          trajectoryScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `([...document.querySelectorAll('[data-ui="trajectory-tabs"] [role="tab"]')].find((button) => button.textContent?.includes("原始事件")))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const rawTraceScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `trajectory-events-${String(size.width)}x${String(size.height)}.png`),
          rawTraceScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `([...document.querySelectorAll('[data-ui="workspace-tabs"] [role="tab"]')].find((button) => button.textContent?.trim() === "对话"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const workspaceScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-${String(size.width)}x${String(size.height)}.png`),
          workspaceScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `([...document.querySelectorAll('[data-ui="right-panel-tabs"] [role="tab"]')].find((button) => button.textContent?.includes("任务")))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const taskPanelScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-tasks-${String(size.width)}x${String(size.height)}.png`),
          taskPanelScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `([...document.querySelectorAll('[data-ui="right-panel-tabs"] [role="tab"]')].find((button) => button.textContent?.includes("成员")))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await window.webContents.executeJavaScript(
          `document.querySelector('.session-row.active .session-actions-trigger')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sessionMenuScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-session-menu-${String(size.width)}x${String(size.height)}.png`),
          sessionMenuScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
          true,
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('.workspace-actions-trigger')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const workspaceMenuScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-project-menu-${String(size.width)}x${String(size.height)}.png`),
          workspaceMenuScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
          true,
        );
        await window.webContents.executeJavaScript(
          `(document.querySelector(".right-sidebar-toggle"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const rightCollapsedScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-right-collapsed-${String(size.width)}x${String(size.height)}.png`),
          rightCollapsedScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `(document.querySelector(".right-sidebar-toggle"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        await window.webContents.executeJavaScript(
          `(document.querySelector(".left-sidebar-toggle"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const collapsedWorkspaceScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-left-collapsed-${String(size.width)}x${String(size.height)}.png`),
          collapsedWorkspaceScreenshot.toPNG(),
        );
        await window.webContents.executeJavaScript(
          `(document.querySelector(".left-sidebar-toggle"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    console.log(
      `Electron smoke passed: ${result.roomId}, ${String(result.agentCount)} agents; workspace/session navigation ${layouts.map((layout) => `${String(layout.width)}x${String(layout.height)}`).join(" and ")}.`,
    );
    exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    unregisterIpc?.();
    window?.destroy();
    try {
      await workspaceHost?.close();
    } catch (error) {
      console.error("Could not close Electron smoke workspace:", error);
      exitCode = 1;
    }
    clearTimeout(deadline);
    app.exit(exitCode);
  }
}

function smokeAdapterRegistry(): WorkspaceAdapterRegistry {
  return new WorkspaceAdapterRegistry([
    Object.freeze({
      kind: "opencode-acp" as const,
      create: () => smokeAdapter("smoke-opencode"),
    }),
    Object.freeze({
      kind: "codex-native" as const,
      create: () => smokeAdapter("smoke-codex"),
    }),
  ]);
}

function startedAgentCount(): number {
  return startedAgentIds.size;
}

function smokeAdapter(kind: string): ReturnType<WorkspaceAdapterRegistry["create"]> {
  type SmokeAdapter = ReturnType<WorkspaceAdapterRegistry["create"]>;
  type SmokeSession = Awaited<ReturnType<SmokeAdapter["start"]>>;
  const capabilities = Object.freeze({
    persistentSession: true,
    streaming: false,
    cancel: true,
    loadSession: true,
    transport: "scripted" as const,
  });
  return Object.freeze({
    kind,
    capabilities,
    probe: async () => Object.freeze({ available: true, command: kind, version: "smoke" }),
    start: async (config: Parameters<SmokeAdapter["start"]>[0]) => {
      startedAgentIds.add(config.agentId);
      const id = config.sessionId ?? `${kind}:${String(nextSmokeSession++)}`;
      return Object.freeze({
        id,
        agentId: config.agentId,
        capabilities,
        status: "ready" as const,
        prompt: async (input: Parameters<SmokeSession["prompt"]>[0]) => Object.freeze({
          turnId: input.turnId,
          text: "",
          stopReason: "completed" as const,
        }),
        cancel: async () => undefined,
        events: async function* () {
          return;
        },
        stop: async () => undefined,
      });
    },
  });
}

function finishWithError(error: unknown): void {
  console.error(error instanceof Error ? error.stack : String(error));
  clearTimeout(deadline);
  app.exit(1);
}
