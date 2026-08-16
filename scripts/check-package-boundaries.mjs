import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowedDependencies = new Map([
  ["@ai-mesh/protocol", []],
  ["@ai-mesh/application", ["@ai-mesh/protocol"]],
  ["@ai-mesh/room", ["@ai-mesh/protocol"]],
  ["@ai-mesh/runtime", ["@ai-mesh/protocol", "@ai-mesh/room"]],
  ["@ai-mesh/agent", []],
  ["@ai-mesh/adapter-acp", ["@ai-mesh/agent"]],
  ["@ai-mesh/adapter-native", ["@ai-mesh/agent"]],
  [
    "@ai-mesh/collaboration",
    [
      "@ai-mesh/application",
      "@ai-mesh/agent",
      "@ai-mesh/protocol",
      "@ai-mesh/room",
      "@ai-mesh/runtime",
    ],
  ],
  [
    "@ai-mesh/store-sqlite",
    ["@ai-mesh/protocol", "@ai-mesh/room", "@ai-mesh/runtime"],
  ],
  [
    "@ai-mesh/workspace",
    [
      "@ai-mesh/application",
      "@ai-mesh/adapter-acp",
      "@ai-mesh/adapter-native",
      "@ai-mesh/agent",
      "@ai-mesh/collaboration",
      "@ai-mesh/protocol",
      "@ai-mesh/room",
      "@ai-mesh/store-sqlite",
    ],
  ],
  ["@ai-mesh/evals", ["@ai-mesh/protocol", "@ai-mesh/room", "@ai-mesh/runtime"]],
  ["@ai-mesh/cli", ["@ai-mesh/protocol", "@ai-mesh/workspace"]],
  [
    "@ai-mesh/desktop",
    ["@ai-mesh/application", "@ai-mesh/protocol", "@ai-mesh/workspace"],
  ],
]);

const workspaces = discoverWorkspaces();
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
const byDirectory = new Map(workspaces.map((workspace) => [workspace.directory, workspace]));
const errors = [];

for (const workspace of workspaces) {
  const allowed = allowedDependencies.get(workspace.name);
  if (allowed === undefined) {
    errors.push(`${workspace.name}: missing from the package-boundary policy.`);
    continue;
  }
  const allowedSet = new Set(allowed);
  const declared = internalDependencies(workspace.manifest);
  const imported = sourceImports(workspace);
  const referenced = projectReferences(workspace);

  for (const dependency of declared) {
    if (!allowedSet.has(dependency)) {
      errors.push(`${workspace.name}: dependency ${dependency} is not allowed by its layer.`);
    }
  }
  for (const dependency of imported) {
    if (dependency === workspace.name) {
      errors.push(`${workspace.name}: import itself through its package name; use a relative module.`);
    } else if (!declared.has(dependency)) {
      errors.push(`${workspace.name}: imports undeclared workspace dependency ${dependency}.`);
    }
  }
  for (const dependency of declared) {
    if (!referenced.has(dependency)) {
      errors.push(`${workspace.name}: declares ${dependency} without a TypeScript project reference.`);
    }
  }
  for (const dependency of referenced) {
    if (!declared.has(dependency)) {
      errors.push(`${workspace.name}: references undeclared workspace dependency ${dependency}.`);
    }
  }
}

enforceBrowserBoundary();
detectCycles();

if (errors.length > 0) {
  throw new Error(`Package boundary check failed:\n- ${errors.join("\n- ")}`);
}

console.log(`Package boundaries passed: ${String(workspaces.length)} workspaces, acyclic.`);

function discoverWorkspaces() {
  const found = [];
  for (const parent of [join(root, "packages"), join(root, "apps")]) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = join(parent, entry.name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") {
        throw new TypeError(`${manifestPath} requires a package name.`);
      }
      found.push({ name: manifest.name, directory, manifest });
    }
  }
  return found;
}

function internalDependencies(manifest) {
  const names = new Set();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@ai-mesh/")) {
        if (!byName.has(name)) {
          errors.push(`${manifest.name}: declares unknown workspace dependency ${name}.`);
        }
        names.add(name);
      }
    }
  }
  return names;
}

function sourceImports(workspace) {
  const names = new Set();
  const sourceDirectory = join(workspace.directory, "src");
  if (!existsSync(sourceDirectory)) {
    return names;
  }
  for (const file of walkSourceFiles(sourceDirectory)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'](@ai-mesh\/[a-z0-9-]+)(?:\/[^"']*)?["']/g)) {
      const name = match[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(path));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function projectReferences(workspace) {
  const names = new Set();
  const visited = new Set();
  collectProjectReferences(join(workspace.directory, "tsconfig.json"), workspace, names, visited);
  return names;
}

function collectProjectReferences(configPath, owner, names, visited) {
  const canonical = resolve(configPath);
  if (visited.has(canonical) || !existsSync(canonical)) {
    return;
  }
  visited.add(canonical);
  const config = JSON.parse(readFileSync(canonical, "utf8"));
  for (const reference of config.references ?? []) {
    if (typeof reference.path !== "string") {
      continue;
    }
    const target = resolveReference(dirname(canonical), reference.path);
    const targetDirectory = statSync(target).isDirectory() ? target : dirname(target);
    const targetWorkspace = byDirectory.get(targetDirectory);
    if (targetWorkspace !== undefined && targetWorkspace.name !== owner.name) {
      names.add(targetWorkspace.name);
      continue;
    }
    if (targetDirectory === owner.directory || target.startsWith(`${owner.directory}/`)) {
      collectProjectReferences(
        statSync(target).isDirectory() ? join(target, "tsconfig.json") : target,
        owner,
        names,
        visited,
      );
    }
  }
}

function resolveReference(base, reference) {
  const target = resolve(base, reference);
  if (existsSync(target)) {
    return target;
  }
  if (existsSync(`${target}.json`)) {
    return `${target}.json`;
  }
  throw new Error(`Unresolved TypeScript project reference: ${target}`);
}

function enforceBrowserBoundary() {
  const browserSafe = new Set(["@ai-mesh/application", "@ai-mesh/protocol"]);
  const desktop = byName.get("@ai-mesh/desktop");
  if (desktop === undefined) {
    return;
  }
  for (const subtree of ["renderer", "shared"]) {
    const directory = join(desktop.directory, "src", subtree);
    for (const file of walkSourceFiles(directory)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/["'](@ai-mesh\/[a-z0-9-]+)(?:\/[^"']*)?["']/g)) {
        const dependency = match[1];
        if (dependency !== undefined && !browserSafe.has(dependency)) {
          errors.push(
            `${relative(root, file)}: browser code cannot import host package ${dependency}.`,
          );
        }
      }
      if (/["']node:/.test(source)) {
        errors.push(`${relative(root, file)}: browser code cannot import Node built-ins.`);
      }
    }
  }

  const application = byName.get("@ai-mesh/application");
  if (application !== undefined) {
    for (const file of walkSourceFiles(join(application.directory, "src"))) {
      const source = readFileSync(file, "utf8");
      if (/["']node:/.test(source)) {
        errors.push(`${relative(root, file)}: application contracts must remain browser-safe.`);
      }
    }
  }
}

function detectCycles() {
  const graph = new Map(
    workspaces.map((workspace) => [workspace.name, internalDependencies(workspace.manifest)]),
  );
  const visiting = new Set();
  const visited = new Set();

  function visit(name, path) {
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      errors.push(`workspace dependency cycle: ${[...path.slice(start), name].join(" -> ")}.`);
      return;
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) {
      visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of graph.keys()) {
    visit(name, []);
  }
}
