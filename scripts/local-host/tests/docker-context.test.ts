import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const entries = readFileSync(
  new URL("../../../docker/host/Dockerfile.dockerignore", import.meta.url),
  "utf8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

test("the host build context excludes live and backup participant credentials", () => {
  expect(entries).toContain("apps/participant-portal/public/runtime-config.json");
  expect(entries).toContain("apps/participant-portal/public/runtime-config.backup.json");
});

test("the host build context excludes environment files recursively but keeps examples", () => {
  // This Dockerfile-specific file replaces the root .dockerignore. Pin the
  // security rules and their order rather than approximating Docker's matcher:
  // a bare .env misses nested workspaces, and the example exception must come last.
  expect(entries.filter((entry) => entry.includes(".env"))).toEqual([
    ".env",
    "**/.env",
    "**/.env.*",
    "!**/.env.example",
  ]);
});
