import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const checked = [];

for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const directory = join(packagesDirectory, entry.name);
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rootExport = manifest.exports?.["."];
  if (rootExport === undefined) {
    continue;
  }
  if (typeof manifest.name !== "string") {
    throw new TypeError(`${manifestPath} requires a package name.`);
  }
  if (typeof rootExport !== "object" || rootExport === null) {
    throw new TypeError(`${manifest.name} must expose typed package exports.`);
  }
  for (const field of ["types", "default"]) {
    const target = rootExport[field];
    if (typeof target !== "string" || !existsSync(join(directory, target))) {
      throw new Error(`${manifest.name} has an unresolved ${field} export: ${String(target)}`);
    }
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const api = await import(${JSON.stringify(manifest.name)}); if (Object.keys(api).length === 0) throw new Error("empty public API");`,
    ],
    { cwd: directory, stdio: "pipe" },
  );
  checked.push(manifest.name);
}

if (checked.length === 0) {
  throw new Error("No workspace package exports were checked.");
}

console.log(`Workspace exports passed: ${checked.join(", ")}`);
