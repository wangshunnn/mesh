import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app } from "electron";

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
    workspaceHost = DesktopWorkspaceHost.open(root, { meshHome });
    unregisterIpc = registerDesktopIpc(workspaceHost, {
      chooseWorkspaceDirectory: async () => secondRoot,
    });

    window = new BrowserWindow({
      show: false,
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
        while (document.querySelector(".shell") === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (window.mesh === undefined) throw new Error("preload bridge is missing");
        const snapshot = await window.mesh.snapshot();
        const config = await window.mesh.configPreview();
        const configButton = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "配置"
        );
        if (!(configButton instanceof HTMLButtonElement)) throw new Error("config navigation is missing");
        configButton.click();
        const renderDeadline = Date.now() + 1000;
        while (document.querySelector(".configuration-view") === null && Date.now() < renderDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const nameInput = document.querySelector(".configuration-agent-form input");
        const saveButton = document.querySelector(".configuration-save");
        if (!(nameInput instanceof HTMLInputElement)) throw new Error("configuration name input is missing");
        if (!(saveButton instanceof HTMLButtonElement)) throw new Error("configuration save button is missing");
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
          configRoomId: config.config.roomId,
          configSource: config.source,
          savedConfigSource: savedConfig.source,
          savedConfigRevision: savedConfig.revision,
          savedAgentName: savedConfig.config.agents[0]?.name ?? "",
          configEditable: document.querySelector(".editable-pill") !== null,
          configRendered: document.querySelector(".configuration-view") !== null,
          rendered: document.querySelector(".shell") !== null,
          errorBanner: document.querySelector(".error-banner")?.textContent ?? ""
        };
      })()`,
      true,
    )) as {
      readonly roomId: string;
      readonly agentCount: number;
      readonly configRoomId: string;
      readonly configSource: string;
      readonly savedConfigSource: string;
      readonly savedConfigRevision: string | null;
      readonly savedAgentName: string;
      readonly configEditable: boolean;
      readonly configRendered: boolean;
      readonly rendered: boolean;
      readonly errorBanner: string;
    };
    if (
      !result.rendered ||
      !result.configRendered ||
      !result.configEditable ||
      result.roomId !== "room:main" ||
      result.configRoomId !== "room:main" ||
      result.configSource !== "default" ||
      result.savedConfigSource !== "file" ||
      result.savedConfigRevision === null ||
      result.savedAgentName !== "OpenCode Smoke" ||
      result.agentCount !== 2
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

        const newSessionButton = document.querySelector(
          '[data-workspace-id="' + firstWorkspaceId + '"] .new-session'
        );
        if (!(newSessionButton instanceof HTMLButtonElement)) throw new Error("new session action is missing");
        newSessionButton.click();
        await waitFor(
          () => document.querySelector('.session-item.active')?.getAttribute('data-session-id') !== firstSessionId,
          "new session did not become active"
        );
        const createdCatalog = await window.mesh.workspaceCatalog();
        const secondSessionId = createdCatalog.activeSessionId;
        const newSnapshot = await window.mesh.snapshot();
        await window.mesh.postMessage({ text: "Second smoke Room history" });

        newSessionButton.click();
        await waitFor(
          () => {
            const active = document.querySelector('.session-item.active')?.getAttribute('data-session-id');
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
              const active = document.querySelector('.session-item.active')?.getAttribute('data-session-id');
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
          () => document.querySelector('.session-item.active')?.getAttribute('data-session-id') === overflowSessionId,
          "overflow session did not become active"
        );
        const firstWorkspaceGroup = document.querySelector('[data-workspace-id="' + firstWorkspaceId + '"]');
        if (!(firstWorkspaceGroup instanceof HTMLElement)) throw new Error("first workspace group is missing");
        const visibleBeforeExpand = firstWorkspaceGroup.querySelectorAll('.session-item').length;
        const overflowButtonLabel = firstWorkspaceGroup.querySelector('.session-overflow')?.textContent?.trim() ?? "";
        const projectToggle = firstWorkspaceGroup.querySelector('.workspace-toggle');
        if (!(projectToggle instanceof HTMLButtonElement)) throw new Error("project collapse action is missing");
        projectToggle.click();
        await waitFor(() => firstWorkspaceGroup.classList.contains('group-collapsed'), "project did not collapse");
        const collapsedProjectSessions = firstWorkspaceGroup.querySelectorAll('.session-item').length;
        projectToggle.click();
        await waitFor(() => !firstWorkspaceGroup.classList.contains('group-collapsed'), "project did not expand");
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
          () => document.querySelector('.session-item.active')?.getAttribute('data-session-id') === firstSessionId,
          "first session did not become active"
        );
        const returnedCatalog = await window.mesh.workspaceCatalog();
        const returnedSnapshot = await window.mesh.snapshot();
        const archivedSessionRow = document.querySelector(
          '[data-session-id="' + overflowSessionId + '"]'
        )?.closest('.session-row');
        const archivedSessionButton = archivedSessionRow?.querySelector('.session-actions-trigger');
        if (!(archivedSessionButton instanceof HTMLButtonElement)) throw new Error("empty session actions trigger is missing");
        archivedSessionButton.click();
        await waitFor(() => document.querySelector('.session-action-menu') !== null, "session actions menu did not open");
        const archiveMenuItem = document.querySelector('.session-action-menu [role="menuitem"]');
        if (!(archiveMenuItem instanceof HTMLButtonElement)) throw new Error("archive session menu item is missing");
        const sessionMenuItemLabel = archiveMenuItem.textContent?.trim() ?? "";
        archiveMenuItem.click();
        await waitFor(
          () => document.querySelector('[data-session-id="' + overflowSessionId + '"]') === null,
          "empty session did not leave the catalog"
        );
        const archivedCatalog = await window.mesh.workspaceCatalog();

        const leftSidebarToggle = document.querySelector('.left-sidebar-toggle');
        if (!(leftSidebarToggle instanceof HTMLButtonElement)) throw new Error("left sidebar toggle is missing");
        leftSidebarToggle.click();
        await waitFor(() => document.querySelector('.workspace-sidebar')?.classList.contains('collapsed') === true, "left sidebar did not collapse");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const collapsedLeftWidth = document.querySelector('.workspace-main')?.getBoundingClientRect().left ?? -1;
        const collapsedSidebarOverlayWidth = document.querySelector('.workspace-sidebar')?.getBoundingClientRect().width ?? 0;
        const collapsedToggleRect = leftSidebarToggle.getBoundingClientRect();
        const collapsedToggleHitTarget = document.elementFromPoint(
          collapsedToggleRect.left + collapsedToggleRect.width / 2,
          collapsedToggleRect.top + collapsedToggleRect.height / 2
        )?.closest('.left-sidebar-toggle') === leftSidebarToggle;
        leftSidebarToggle.click();
        await waitFor(() => document.querySelector('.workspace-sidebar')?.classList.contains('collapsed') === false, "left sidebar did not expand");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedLeftWidth = document.querySelector('.workspace-sidebar')?.getBoundingClientRect().width ?? 0;
        const expandedToggleRect = leftSidebarToggle.getBoundingClientRect();

        const rightSidebarToggle = document.querySelector('.right-sidebar-toggle');
        if (!(rightSidebarToggle instanceof HTMLButtonElement)) throw new Error("right sidebar toggle is missing");
        rightSidebarToggle.click();
        await waitFor(() => document.querySelector('.workspace-grid')?.classList.contains('right-collapsed') === true, "right sidebar did not collapse");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const collapsedRightWidth = document.querySelector('.right-column')?.getBoundingClientRect().width ?? 0;
        rightSidebarToggle.click();
        await waitFor(() => document.querySelector('.workspace-grid')?.classList.contains('right-collapsed') === false, "right sidebar did not expand");
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedRightWidth = document.querySelector('.right-column')?.getBoundingClientRect().width ?? 0;
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
          () => document.querySelector('.session-item.active')?.getAttribute('data-session-id') === firstSessionId,
          "original workspace session did not reactivate"
        );
        const inactiveWorkspaceGroup = [...document.querySelectorAll('.workspace-group')].find(
          (group) => group.getAttribute('data-workspace-id') !== firstWorkspaceId
        );
        const inactiveWorkspaceToggle = inactiveWorkspaceGroup?.querySelector('.workspace-toggle');
        if (!(inactiveWorkspaceToggle instanceof HTMLButtonElement)) throw new Error("inactive project toggle is missing");
        inactiveWorkspaceToggle.click();
        const inactiveWorkspaceHeading = inactiveWorkspaceToggle.closest('.workspace-group-heading');
        const inactiveWorkspaceFocusBackground = inactiveWorkspaceHeading === null
          ? "missing"
          : getComputedStyle(inactiveWorkspaceHeading).backgroundColor;
        inactiveWorkspaceToggle.click();
        const finalCatalog = await window.mesh.workspaceCatalog();
        return {
          firstWorkspaceId,
          firstSessionId,
          secondSessionId,
          blankSessionId,
          blankReusedSessionId: blankReusedCatalog.activeSessionId,
          blankCreatedCount,
          blankReusedCount,
          overflowSessionCount: overflowCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.length ?? 0,
          archivedSessionCount: archivedCatalog.workspaces.find((item) => item.id === firstWorkspaceId)?.sessions.length ?? 0,
          sessionMenuItemLabel,
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
          collapsedSidebarOverlayWidth,
          collapsedToggleHitTarget,
          expandedLeftWidth,
          collapsedToggleLeft: collapsedToggleRect.left,
          collapsedToggleTop: collapsedToggleRect.top,
          collapsedToggleHeight: collapsedToggleRect.height,
          expandedToggleLeft: expandedToggleRect.left,
          expandedToggleTop: expandedToggleRect.top,
          collapsedRightWidth,
          expandedRightWidth,
          navigationHeight,
          rootFontSize: rootStyle.fontSize,
          rootFontFamily: rootStyle.fontFamily,
          sidebarColor,
          sessionFontSize,
          messageFontSize,
          inactiveWorkspaceFocusBackground,
          activeSessionCount: document.querySelectorAll('.session-item.active').length,
          renderedWorkspaceGroups: document.querySelectorAll('.workspace-group').length,
          renderedSessions: document.querySelectorAll('.session-item').length,
          sidebarRendered: document.querySelector('.workspace-sidebar') !== null,
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
      readonly overflowSessionCount: number;
      readonly archivedSessionCount: number;
      readonly sessionMenuItemLabel: string;
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
      readonly collapsedSidebarOverlayWidth: number;
      readonly collapsedToggleHitTarget: boolean;
      readonly expandedLeftWidth: number;
      readonly collapsedToggleLeft: number;
      readonly collapsedToggleTop: number;
      readonly collapsedToggleHeight: number;
      readonly expandedToggleLeft: number;
      readonly expandedToggleTop: number;
      readonly collapsedRightWidth: number;
      readonly expandedRightWidth: number;
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
      navigation.overflowSessionCount !== 6 ||
      navigation.archivedSessionCount !== 5 ||
      navigation.sessionMenuItemLabel !== "归档会话" ||
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
      navigation.collapsedSidebarOverlayWidth !== 148 ||
      !navigation.collapsedToggleHitTarget ||
      navigation.expandedLeftWidth < 240 ||
      navigation.collapsedToggleLeft < 76 ||
      navigation.collapsedToggleLeft > 80 ||
      navigation.collapsedToggleTop < 7 ||
      navigation.collapsedToggleTop > 9 ||
      navigation.collapsedToggleHeight !== 30 ||
      navigation.expandedToggleLeft !== navigation.collapsedToggleLeft ||
      navigation.expandedToggleTop !== navigation.collapsedToggleTop ||
      navigation.collapsedRightWidth !== 48 ||
      navigation.expandedRightWidth < 292 ||
      navigation.navigationHeight > 78 ||
      navigation.rootFontSize !== "14px" ||
      !navigation.rootFontFamily.includes("-apple-system") ||
      navigation.sidebarColor !== "rgb(249, 249, 249)" ||
      navigation.sessionFontSize < 13 ||
      navigation.messageFontSize < 14 ||
      navigation.inactiveWorkspaceFocusBackground !== "rgba(0, 0, 0, 0)" ||
      navigation.activeSessionCount !== 1 ||
      navigation.renderedWorkspaceGroups !== 2 ||
      navigation.renderedSessions !== 6 ||
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
          const roomButton = [...document.querySelectorAll(".breadcrumb button")].find(
            (button) => button.textContent?.trim() === "对话"
          );
          if (!(roomButton instanceof HTMLButtonElement)) throw new Error("room navigation is missing");
          roomButton.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebar = document.querySelector(".workspace-sidebar");
          const main = document.querySelector(".workspace-main");
          const grid = document.querySelector(".workspace-grid");
          const sessionItems = [...document.querySelectorAll(".session-item")];
          const roomLayout = {
            sidebarOverflow: sidebar === null ? true : sidebar.scrollWidth > sidebar.clientWidth,
            mainOverflow: main === null ? true : main.scrollWidth > main.clientWidth,
            gridOverflow: grid === null ? true : grid.scrollWidth > grid.clientWidth,
            minimumSessionWidth: sessionItems.length === 0 ? 0 : Math.min(...sessionItems.map((item) => item.getBoundingClientRect().width)),
            sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
            chatWidth: document.querySelector(".chat-column")?.getBoundingClientRect().width ?? 0
          };
          const configButton = [...document.querySelectorAll(".breadcrumb button")].find(
            (button) => button.textContent?.trim() === "配置"
          );
          if (!(configButton instanceof HTMLButtonElement)) throw new Error("config navigation is missing");
          configButton.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const configView = document.querySelector(".configuration-view");
          const configScroll = document.querySelector(".configuration-scroll");
          const cards = [...document.querySelectorAll(".configuration-agent")];
          return {
            width: window.innerWidth,
            height: window.innerHeight,
            documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            ...roomLayout,
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
      readonly chatWidth: number;
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
          `([...document.querySelectorAll(".breadcrumb button")].find((button) => button.textContent?.trim() === "对话"))?.click()`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const workspaceScreenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `workspace-${String(size.width)}x${String(size.height)}.png`),
          workspaceScreenshot.toPNG(),
        );
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

function finishWithError(error: unknown): void {
  console.error(error instanceof Error ? error.stack : String(error));
  clearTimeout(deadline);
  app.exit(1);
}
