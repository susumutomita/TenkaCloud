import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspaces, planTask } from "../../../scripts/workspace/run-workspaces";

/**
 * Issue #2206: the root `typecheck`/`test`/`test:coverage` scripts used to enumerate
 * workspace packages by hand (`bun run --filter <name> <script>`), so a new package under
 * `packages` with its own `test`/`typecheck` script could silently be left out of CI —
 * exactly what happened to `@tenkacloud/portal-plugin-sdk` and `@tenkacloud/problem-test`.
 *
 * The hand-maintained chains were replaced by the `scripts/workspace/run-workspaces.ts` orchestrator,
 * which discovers workspaces from the root `workspaces` globs, so a new package can no
 * longer be forgotten. This test keeps the #2206 blind-spot closed against the new seam:
 * every package under `packages` whose package.json declares a `test`/`typecheck` script
 * must be part of the orchestrator's plan for that task, and the root scripts must actually
 * delegate to the orchestrator (otherwise the plan proves nothing).
 *
 * `test:coverage` is not asserted here: it is owned by `scripts/workspace/run-coverage.ts` (#2513),
 * and scripts/workspace/run-coverage.test.ts pins its 17-dir COVERAGE_WORKSPACES list.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

interface RootScripts {
  readonly build: string;
  readonly typecheck: string;
  readonly test: string;
}

function rootScripts(): RootScripts {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: RootScripts;
  };
  return root.scripts;
}

function packagesWithScript(scriptName: "typecheck" | "test"): readonly string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, entry.name, "package.json");
    let pkg: { name?: unknown; scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue; // no package.json (e.g. a stray non-package directory)
    }
    if (typeof pkg.name === "string" && typeof pkg.scripts?.[scriptName] === "string") {
      dirs.push(`packages/${entry.name}`);
    }
  }
  return dirs;
}

function plannedDirs(task: "typecheck" | "test"): readonly string[] {
  const plan = planTask(task, discoverWorkspaces(REPO_ROOT));
  return plan.included.map((workspace) => workspace.dir);
}

describe("root package.json quality-gate enumeration (issue #2206)", () => {
  it("should delegate the root build, typecheck, and test scripts to the workspace orchestrator", () => {
    const { build, typecheck, test } = rootScripts();
    expect(build).toContain("scripts/workspace/run-workspaces.ts build");
    expect(typecheck).toContain("scripts/workspace/run-workspaces.ts typecheck");
    expect(test).toContain("scripts/workspace/run-workspaces.ts test");
  });

  it("should list every packages/* with a typecheck script in the root typecheck script", () => {
    const planned = plannedDirs("typecheck");
    const missing = packagesWithScript("typecheck").filter((dir) => !planned.includes(dir));
    expect(missing).toEqual([]);
  });

  it("should list every packages/* with a test script in the root test script", () => {
    const planned = plannedDirs("test");
    const missing = packagesWithScript("test").filter((dir) => !planned.includes(dir));
    expect(missing).toEqual([]);
  });
});
