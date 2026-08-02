import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const runtimeRoot = path.join(packageRoot, "runtime");

const roots = [
  "apps",
  "infrastructure",
  "scripts",
  "packages",
  "package.json",
  "bun.lock",
  "Makefile",
  "biome.json",
  "tsconfig.json",
];

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

for (const relative of roots) {
  const source = path.join(repositoryRoot, relative);
  const destination = path.join(runtimeRoot, relative);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      const normalized = candidate.split(path.sep).join("/");
      return (
        !normalized.includes("/node_modules/") &&
        !normalized.includes("/cdk.out/") &&
        !normalized.includes("/dist/") &&
        !normalized.includes("/packages/standalone-cli/runtime")
      );
    },
  });
}

console.log(`Assembled standalone runtime at ${runtimeRoot}`);
