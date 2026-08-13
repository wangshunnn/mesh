import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app, ipcMain } from "electron";

import { MeshWorkspace } from "@ai-mesh/workspace";

import { desktopChannels } from "../shared/api.js";

const root = mkdtempSync(join(tmpdir(), "mesh-electron-smoke-"));
const rendererErrors: string[] = [];
let workspace: MeshWorkspace | undefined;
let window: BrowserWindow | undefined;
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
    const activeWorkspace = workspace;
    ipcMain.handle(desktopChannels.snapshot, () => activeWorkspace.snapshot());
    ipcMain.handle(desktopChannels.probeAgents, async () => {
      const probes = await activeWorkspace.probeAgents();
      return probes.map((probe) => ({
        id: probe.id,
        available: probe.availability.available,
        ...(probe.availability.version === undefined ? {} : { version: probe.availability.version }),
        ...(probe.availability.reason === undefined ? {} : { reason: probe.availability.reason }),
      }));
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
        return {
          roomId: snapshot.roomId,
          agentCount: snapshot.agents.length,
          rendered: document.querySelector(".shell") !== null,
          errorBanner: document.querySelector(".error-banner")?.textContent ?? ""
        };
      })()`,
      true,
    )) as {
      readonly roomId: string;
      readonly agentCount: number;
      readonly rendered: boolean;
      readonly errorBanner: string;
    };
    if (!result.rendered || result.roomId !== "room:main" || result.agentCount !== 2) {
      throw new Error(`Unexpected desktop state: ${JSON.stringify(result)}`);
    }
    if (result.errorBanner.length > 0 || rendererErrors.length > 0) {
      throw new Error(
        `Renderer diagnostics: ${[result.errorBanner, ...rendererErrors].filter(Boolean).join(" | ")}`,
      );
    }
    console.log(`Electron smoke passed: ${result.roomId}, ${String(result.agentCount)} agents.`);
    exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    ipcMain.removeHandler(desktopChannels.snapshot);
    ipcMain.removeHandler(desktopChannels.probeAgents);
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
