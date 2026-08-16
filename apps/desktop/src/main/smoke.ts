import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app } from "electron";

import { MeshWorkspace } from "@ai-mesh/workspace";

import { registerDesktopIpc } from "./ipc.js";

const root = mkdtempSync(join(tmpdir(), "mesh-electron-smoke-"));
const screenshotDirectory = process.env.MESH_SMOKE_SCREENSHOT_DIR;
const rendererErrors: string[] = [];
let workspace: MeshWorkspace | undefined;
let window: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;
let exitCode = 1;
const deadline = setTimeout(() => {
  console.error("Electron smoke timed out after 15 seconds.");
  app.exit(1);
}, 15_000);

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
    workspace = MeshWorkspace.open({ root });
    unregisterIpc = registerDesktopIpc(workspace);

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
        return {
          roomId: snapshot.roomId,
          agentCount: snapshot.agents.length,
          configRoomId: config.config.roomId,
          configSource: config.source,
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
      readonly configRendered: boolean;
      readonly rendered: boolean;
      readonly errorBanner: string;
    };
    if (
      !result.rendered ||
      !result.configRendered ||
      result.roomId !== "room:main" ||
      result.configRoomId !== "room:main" ||
      result.configSource !== "default" ||
      result.agentCount !== 2
    ) {
      throw new Error(`Unexpected desktop state: ${JSON.stringify(result)}`);
    }
    if (result.errorBanner.length > 0 || rendererErrors.length > 0) {
      throw new Error(
        `Renderer diagnostics: ${[result.errorBanner, ...rendererErrors].filter(Boolean).join(" | ")}`,
      );
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
          const view = document.querySelector(".configuration-view");
          const scroll = document.querySelector(".configuration-scroll");
          const cards = [...document.querySelectorAll(".configuration-agent")];
          return {
            width: window.innerWidth,
            height: window.innerHeight,
            documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            viewOverflow: view === null ? true : view.scrollWidth > view.clientWidth,
            scrollOverflow: scroll === null ? true : scroll.scrollWidth > scroll.clientWidth,
            minimumCardWidth: cards.length === 0 ? 0 : Math.min(...cards.map((card) => card.getBoundingClientRect().width))
          };
        })()`,
        true,
      )) as {
        readonly width: number;
        readonly height: number;
        readonly documentOverflow: boolean;
        readonly viewOverflow: boolean;
        readonly scrollOverflow: boolean;
        readonly minimumCardWidth: number;
      };
      layouts.push(layout);
      if (
        layout.width !== size.width ||
        layout.height !== size.height ||
        layout.documentOverflow ||
        layout.viewOverflow ||
        layout.scrollOverflow ||
        layout.minimumCardWidth < 300
      ) {
        throw new Error(`Unexpected configuration layout: ${JSON.stringify(layout)}`);
      }
      if (screenshotDirectory !== undefined) {
        mkdirSync(screenshotDirectory, { recursive: true });
        const screenshot = await window.webContents.capturePage();
        writeFileSync(
          join(screenshotDirectory, `configuration-${String(size.width)}x${String(size.height)}.png`),
          screenshot.toPNG(),
        );
      }
    }
    console.log(
      `Electron smoke passed: ${result.roomId}, ${String(result.agentCount)} agents; configuration ${layouts.map((layout) => `${String(layout.width)}x${String(layout.height)}`).join(" and ")}.`,
    );
    exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    unregisterIpc?.();
    window?.destroy();
    try {
      await workspace?.close();
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
