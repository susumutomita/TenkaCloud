import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectProblemWriteups, containsProblemWriteup } from "../build/strip-problem-writeups";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const catalogRoot = resolve(repoRoot, "problems");
const distRoot = resolve(appRoot, "dist");

function filesUnder(root: string, filename?: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, filename));
    else if (!filename || entry.name === filename) files.push(path);
  }
  return files;
}

const writeups = filesUnder(catalogRoot, "metadata.json").flatMap((path) => {
  return collectProblemWriteups(JSON.parse(readFileSync(path, "utf8")));
});

const bundles = filesUnder(distRoot).map((path) => ({
  path,
  body: readFileSync(path, "utf8"),
}));
for (const writeup of writeups) {
  const leaked = bundles.find(({ body }) => containsProblemWriteup(body, writeup));
  if (leaked) {
    throw new Error(`participant bundle contains a catalog writeup: ${leaked.path}`);
  }
}
console.log(`OK: ${writeups.length} catalog writeup strings are absent from participant dist`);
