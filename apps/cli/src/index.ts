#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { MessageAttention, TaskStatus } from "@ai-mesh/protocol";
import {
  MeshWorkspace,
  inspectWorkspaceStorage,
  previewWorkspaceConfig,
  resolveMeshHome,
  resolveWorkspaceRoot,
  saveWorkspaceConfig,
  validateWorkspaceConfig,
} from "@ai-mesh/workspace";

const argv = process.argv.slice(2);
const command = argv.shift() ?? "help";
const root = resolve(option(argv, "--root") ?? process.cwd());

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

let workspace: MeshWorkspace | undefined;
try {
  if (command === "config") {
    configCommand(root, argv);
  } else {
    workspace = MeshWorkspace.open({ root });
    switch (command) {
      case "init":
        console.log(`Initialized Mesh in ${workspace.dataDirectory}`);
        console.log(`Config: ${workspace.configPath}`);
        console.log(`Database: ${workspace.databasePath}`);
        break;
      case "status":
        printStatus(workspace.snapshot());
        break;
      case "agents":
        await agentsCommand(workspace, argv);
        break;
      case "message":
        await messageCommand(workspace, argv);
        break;
      case "task":
        taskCommand(workspace, argv);
        break;
      case "timeline":
        timelineCommand(workspace, argv);
        break;
      case "demo":
        await demoCommand(workspace);
        break;
      default:
        throw new Error(`Unknown command ${command}. Run mesh help.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await workspace?.close();
}

function configCommand(workspaceRoot: string, args: string[]): void {
  const action = args.shift() ?? "preview";
  if (action === "preview") {
    console.log(JSON.stringify(previewWorkspaceConfig({ root: workspaceRoot }), undefined, 2));
    return;
  }
  if (action !== "validate" && action !== "apply") {
    throw new Error(`Unknown config action ${action}. Run mesh help.`);
  }
  const inputPath = resolve(requireArgument(args, `mesh config ${action} <file>`));
  const document = readJsonDocument(inputPath);
  if (action === "validate") {
    const config = validateWorkspaceConfig(
      isRecord(document) && "config" in document ? document.config : document,
    );
    console.log(
      `Valid workspace config v${String(config.version)}: ${String(config.agents.length)} agent(s).`,
    );
    return;
  }
  const edit = configEditDocument(document, inputPath, workspaceRoot);
  console.log(
    JSON.stringify(
      saveWorkspaceConfig({
        workspaceId: edit.workspaceId,
        root: workspaceRoot,
        meshHome: edit.meshHome,
        config: edit.config,
        expectedRevision: edit.revision,
      }),
      undefined,
      2,
    ),
  );
}

function readJsonDocument(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Config edit document ${path} contains invalid JSON.`, { cause: error });
    }
    throw error;
  }
}

function configEditDocument(
  value: unknown,
  path: string,
  workspaceRoot: string,
): {
  readonly workspaceId: string;
  readonly meshHome: string;
  readonly revision: string | null;
  readonly config: ReturnType<typeof validateWorkspaceConfig>;
} {
  if (!isRecord(value)) {
    throw new Error(`Config edit document ${path} must be created by mesh config preview.`);
  }
  if (
    typeof value.root !== "string" ||
    resolveWorkspaceRoot(value.root) !== resolveWorkspaceRoot(workspaceRoot)
  ) {
    throw new Error(`Config edit document ${path} belongs to a different workspace.`);
  }
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.meshHome !== "string" ||
    resolveMeshHome(value.meshHome) !== resolveMeshHome()
  ) {
    throw new Error(`Config edit document ${path} belongs to a different Mesh home.`);
  }
  const expectedStorage = inspectWorkspaceStorage({
    root: workspaceRoot,
    meshHome: value.meshHome,
    workspaceId: value.workspaceId,
  });
  if (
    typeof value.dataDirectory !== "string" ||
    resolve(value.dataDirectory) !== expectedStorage.dataDirectory
  ) {
    throw new Error(`Config edit document ${path} has an unexpected data directory.`);
  }
  if (value.revision !== null && typeof value.revision !== "string") {
    throw new Error(`Config edit document ${path} has an invalid revision.`);
  }
  return Object.freeze({
    workspaceId: value.workspaceId,
    meshHome: expectedStorage.meshHome,
    revision: value.revision,
    config: validateWorkspaceConfig(value.config),
  });
}

async function agentsCommand(workspace: MeshWorkspace, args: string[]): Promise<void> {
  const action = args.shift() ?? "list";
  if (action === "list") {
    const probes = await workspace.probeAgents();
    for (const probe of probes) {
      console.log(
        `${probe.availability.available ? "●" : "○"} @${probe.handle} ${probe.name} ` +
          `[${probe.adapter}] ${probe.availability.version ?? probe.availability.reason ?? "unknown"}`,
      );
    }
    return;
  }
  const participant = requireArgument(args, `mesh agents ${action} <agent>`);
  switch (action) {
    case "start":
      await workspace.startAgent(participant);
      console.log(`Started ${participant}.`);
      return;
    case "stop":
      await workspace.stopAgent(participant);
      console.log(`Stopped ${participant}.`);
      return;
    case "restart":
      await workspace.restartAgent(participant);
      console.log(`Restarted ${participant}.`);
      return;
    default:
      throw new Error(`Unknown agents action ${action}.`);
  }
}

async function messageCommand(workspace: MeshWorkspace, args: string[]): Promise<void> {
  const startAgents = flag(args, "--start-agents");
  const explicitTo = option(args, "--to");
  const text = args.join(" ").trim();
  if (text.length === 0) {
    throw new Error("Usage: mesh message [--to @agent|team] [--start-agents] <text>");
  }
  if (startAgents) {
    const started = await workspace.startAvailableAgents();
    for (const failure of started.failed) {
      console.error(`Could not start ${failure.agentId}: ${failure.message}`);
    }
  }
  const attention: MessageAttention | undefined =
    explicitTo === undefined
      ? undefined
      : explicitTo.replace(/^@/, "") === "team"
        ? "team"
        : [workspace.resolveParticipant(explicitTo)];
  const event = workspace.postText(text, {
    ...(attention === undefined ? {} : { attention }),
  });
  console.log(`#${String(event.sequence)} ${event.actorId}: ${text}`);
  if (startAgents) {
    await workspace.settle();
    printMessages(workspace.snapshot().messages.slice(1));
  }
}

function taskCommand(workspace: MeshWorkspace, args: string[]): void {
  const action = args.shift() ?? "list";
  switch (action) {
    case "list":
      for (const task of workspace.snapshot().tasks) {
        console.log(
          `${task.id} [${task.status}] ${task.title}${task.ownerId === undefined ? "" : ` — ${task.ownerId}`}`,
        );
      }
      return;
    case "create": {
      const title = args.join(" ").trim();
      if (title.length === 0) {
        throw new Error("Usage: mesh task create <title>");
      }
      const event = workspace.createTask({ title });
      console.log(`Created ${event.subject.id}: ${title}`);
      return;
    }
    case "claim": {
      const taskId = requireArgument(args, "mesh task claim <task-id> <agent>");
      const agent = workspace.resolveParticipant(
        requireArgument(args, "mesh task claim <task-id> <agent>"),
      );
      const result = workspace.claimTask(taskId, agent);
      if (result.status === "committed") {
        console.log(`Claimed ${taskId} for ${agent}.`);
      } else if (result.status === "rejected") {
        throw new Error(`${result.code}: ${result.message}`);
      } else {
        throw new Error(`Task changed; re-read ${taskId} before claiming.`);
      }
      return;
    }
    case "update": {
      const taskId = requireArgument(args, "mesh task update <task-id> <status>");
      const status = requireArgument(args, "mesh task update <task-id> <status>");
      if (!isTaskStatus(status)) {
        throw new Error(`Invalid task status ${status}.`);
      }
      const result = workspace.updateTask({ taskId, status });
      if (result.status !== "committed") {
        throw new Error(`Could not update task ${taskId}: ${result.status}.`);
      }
      console.log(`Updated ${taskId} to ${status}.`);
      return;
    }
    default:
      throw new Error(`Unknown task action ${action}.`);
  }
}

function timelineCommand(workspace: MeshWorkspace, args: string[]): void {
  const limitValue = option(args, "--limit");
  const limit = limitValue === undefined ? 30 : Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  for (const event of workspace.snapshot().timeline.slice(-limit)) {
    console.log(
      `${String(event.sequence).padStart(4)} ${event.action.padEnd(28)} ${event.actorId} ${event.subject.kind}:${event.subject.id}`,
    );
  }
}

async function demoCommand(workspace: MeshWorkspace): Promise<void> {
  const started = await workspace.startAvailableAgents();
  console.log(`Started: ${started.started.join(", ") || "none"}`);
  for (const unavailable of started.unavailable) {
    console.log(`Unavailable: ${unavailable.id} (${unavailable.availability.reason ?? "unknown"})`);
  }
  for (const failed of started.failed) {
    console.log(`Failed: ${failed.agentId} (${failed.message})`);
  }
  const first = started.started[0];
  if (first === undefined) {
    throw new Error("No configured agent could start.");
  }
  workspace.postText(`@${first} say hello to @human`, { attention: [first] });
  await workspace.settle();
  printMessages(workspace.snapshot().messages);
}

function printStatus(snapshot: ReturnType<MeshWorkspace["snapshot"]>): void {
  console.log(`${snapshot.roomId} — head ${String(snapshot.headSequence)}`);
  console.log(`Agents: ${String(snapshot.agents.length)}`);
  for (const agent of snapshot.agents) {
    console.log(`  ${agent.state.padEnd(8)} @${agent.handle} [${agent.adapterKind}]`);
  }
  console.log(`Messages: ${String(snapshot.messages.length)}`);
  console.log(`Tasks: ${String(snapshot.tasks.length)}`);
}

function printMessages(messages: ReturnType<MeshWorkspace["snapshot"]>["messages"]): void {
  for (const message of messages) {
    console.log(`#${String(message.sequence)} ${message.from}: ${message.text}`);
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function requireArgument(args: string[], usage: string): string {
  const value = args.shift();
  if (value === undefined) {
    throw new Error(`Usage: ${usage}`);
  }
  return value;
}

function isTaskStatus(value: string): value is TaskStatus {
  return ["todo", "in_progress", "blocked", "review", "done"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Mesh CLI

Usage: mesh <command> [--root <workspace>]

  init                              register this directory and create local Mesh state
  config preview                    preview effective config without writing files
  config validate <file>            validate a config or preview edit document
  config apply <preview-file>       safely apply an edited config preview
  status                            show room, agents, messages, and tasks
  agents [list]                     probe configured agents
  agents start|stop|restart <agent> manage one agent session
  message [--to <agent|team>] <text>
  task list
  task create <title>
  task claim <task-id> <agent>
  task update <task-id> <status>
  timeline [--limit <n>]
  demo                              run one real-agent room smoke flow
`);
}
