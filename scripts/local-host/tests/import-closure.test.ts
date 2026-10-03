import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostImportClosure } from "../../quality/host-imports";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "host-imports-"));
  directories.push(root);
  for (const [file, source] of Object.entries(files)) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}
test("host runtime imports remain independent of both retired backends, including type edges", () => {
  const closure = hostImportClosure(resolve(import.meta.dir, "../../.."));
  expect(closure).toContain("scripts/local-host/container/scoring.ts");
  expect(closure).toContain("scripts/lib/assume-role.ts");
});
test.each([
  "import type { Data } from '../../local-play/legacy';",
  "export type { Data } from '../../local-play/legacy';",
  "type Data = import('../../local-play/legacy').Data;",
])("rejects an indirect old type dependency: %s", (source) => {
  const root = fixture({
    "scripts/local-host/main.ts": "import './container/model'",
    "scripts/local-host/container/model.ts": source,
    "scripts/local-play/legacy.ts": "export interface Data {}",
  });
  expect(() => hostImportClosure(root)).toThrow(
    "Host dependency reaches scripts/local-play/legacy.ts",
  );
});
test("rejects a dynamic infrastructure import and missing relative module", () => {
  const root = fixture({
    "scripts/local-host/main.ts": "void import('../../infrastructure/legacy.js')",
    "infrastructure/legacy.ts": "export {}",
  });
  expect(() => hostImportClosure(root)).toThrow("Host dependency reaches infrastructure/legacy.ts");
  writeFileSync(join(root, "scripts/local-host/main.ts"), "import './missing'");
  expect(() => hostImportClosure(root)).toThrow("Unresolved host dependency");
});

test("uptime, endpoint and HTTP helper closures include no legacy runtime or type imports", () => {
  const closure = hostImportClosure(resolve(import.meta.dir, "../../.."), [
    "scripts/lib/uptime-flat.ts",
    "scripts/lib/resolve-endpoints.ts",
    "scripts/lib/http-probe-client.ts",
  ]);
  expect(closure).toContain("scripts/lib/scoring-common.ts");
  expect(closure).toContain("scripts/lib/ssrf-guard.ts");
});
