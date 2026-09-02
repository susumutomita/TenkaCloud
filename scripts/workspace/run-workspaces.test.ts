import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkspaces,
  parseJobs,
  planTask,
  TASKS,
  UsageError,
  type WorkspaceInfo,
} from "./run-workspaces";

/**
 * Issue #993 follow-up: the root `package.json` `build` / `typecheck` / `test`
 * scripts used to be hand-maintained `bun run --filter <pkg> && ...` chains.
 * Adding a workspace meant remembering to touch several one-liners by hand,
 * and nothing failed loudly if you forgot. This suite pins
 * scripts/workspace/run-workspaces.ts as the single reviewable seam that replaced
 * them: the repo-parity test below is the thing a reviewer diffs when a
 * workspace is added, removed, or moved between the build/typecheck/test
 * sets. (`test:coverage` is owned by scripts/workspace/run-coverage.ts, #2513, whose
 * own COVERAGE_WORKSPACES registry is a separate list.)
 *
 * The parity list is written out rather than derived: deriving it from the same
 * discovery call it checks would make the test agree with whatever the repo happens
 * to contain, which is the one thing it exists not to do. Adding a workspace is meant
 * to fail here once, so that a human confirms which of build/typecheck/test it joins.
 */

const repoRoot = join(import.meta.dir, "../..");

describe("discoverWorkspaces", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "run-workspaces-discover-"));
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writeJson(relativePath: string, value: unknown): void {
    writeFileSync(join(fixtureRoot, relativePath), JSON.stringify(value), "utf8");
  }

  it("should resolve a literal workspace entry and a trailing /* glob", () => {
    writeJson("package.json", { workspaces: ["solo-app", "libs/*"] });

    mkdirSync(join(fixtureRoot, "solo-app"), { recursive: true });
    writeJson("solo-app/package.json", { name: "solo-app", scripts: { build: "echo build" } });

    mkdirSync(join(fixtureRoot, "libs/foo"), { recursive: true });
    writeJson("libs/foo/package.json", {
      name: "@x/foo",
      scripts: { typecheck: "echo tc", test: "echo test" },
    });

    mkdirSync(join(fixtureRoot, "libs/bar"), { recursive: true });
    writeJson("libs/bar/package.json", { name: "@x/bar", scripts: { typecheck: "echo tc" } });

    const workspaces = discoverWorkspaces(fixtureRoot);
    const sorted = [...workspaces].sort((a, b) => a.dir.localeCompare(b.dir));

    expect(sorted).toEqual([
      { dir: "libs/bar", name: "@x/bar", scripts: { typecheck: "echo tc" } },
      { dir: "libs/foo", name: "@x/foo", scripts: { typecheck: "echo tc", test: "echo test" } },
      { dir: "solo-app", name: "solo-app", scripts: { build: "echo build" } },
    ]);
  });

  it("should skip glob entries that are not directories or lack a package.json", () => {
    writeJson("package.json", { workspaces: ["libs/*"] });

    mkdirSync(join(fixtureRoot, "libs/real"), { recursive: true });
    writeJson("libs/real/package.json", { name: "@x/real", scripts: { test: "echo test" } });

    // A stray file sitting next to the workspace directories under libs/*.
    writeFileSync(join(fixtureRoot, "libs/README.md"), "not a workspace", "utf8");

    // A directory with no package.json (e.g. a scratch folder) must not crash discovery.
    mkdirSync(join(fixtureRoot, "libs/empty"), { recursive: true });

    const workspaces = discoverWorkspaces(fixtureRoot);

    expect(workspaces).toEqual([
      { dir: "libs/real", name: "@x/real", scripts: { test: "echo test" } },
    ]);
  });

  it("should throw when a workspaces glob points at a missing directory", () => {
    writeJson("package.json", { workspaces: ["nowhere/*"] });

    expect(() => discoverWorkspaces(fixtureRoot)).toThrow(/nowhere/);
  });
});

describe("planTask", () => {
  const scriptsAll = { build: "x", typecheck: "x", test: "x" };

  function ws(dir: string, scripts: Record<string, string> = scriptsAll): WorkspaceInfo {
    return { dir, name: dir, scripts };
  }

  it("should throw for an unknown task", () => {
    expect(() => planTask("lint", [ws("infrastructure")])).toThrow(/unknown task/i);
  });

  it("should throw for the retired test:coverage task (owned by run-coverage.ts)", () => {
    expect(() => planTask("test:coverage", [ws("infrastructure")])).toThrow(/unknown task/i);
  });

  it("should throw when a task resolves to zero workspaces", () => {
    const workspaces = [ws("infrastructure", { test: "x" })];
    expect(() => planTask("build", workspaces)).toThrow(/zero workspaces/i);
  });

  it("should restrict build to the infrastructure and apps groups only", () => {
    const workspaces = [
      ws("infrastructure"),
      ws("apps/a"),
      ws("apps/b", { typecheck: "x", test: "x" }), // no build script
      ws("packages/c"), // has build, but packages/* is never built at the root
    ];

    const plan = planTask("build", workspaces);

    expect(plan.included.map((w) => w.dir)).toEqual(["infrastructure", "apps/a"]);
    expect(plan.skipped.map((w) => w.dir)).toEqual(["apps/b"]);
    // packages/c is filtered out by the group rule, not treated as a "skip".
    expect(plan.skipped.some((w) => w.dir === "packages/c")).toBe(false);
  });

  it("should order the plan group-then-alphabetical regardless of input order", () => {
    const workspaces = [
      ws("packages/z"),
      ws("apps/b"),
      ws("infrastructure"),
      ws("apps/a"),
      ws("packages/a"),
    ];

    const plan = planTask("typecheck", workspaces);

    expect(plan.included.map((w) => w.dir)).toEqual([
      "infrastructure",
      "apps/a",
      "apps/b",
      "packages/a",
      "packages/z",
    ]);
  });

  it("should list every supported task", () => {
    expect(TASKS).toEqual(["build", "typecheck", "test"]);
  });
});

describe("repo parity (the reviewable seam)", () => {
  const workspaces = discoverWorkspaces(repoRoot);

  const appsAlphabetical = [
    "apps/admin-console",
    "apps/application-admin-console",
    "apps/developer-portal",
    "apps/participant-portal",
  ];

  const packagesAlphabetical = [
    "packages/ai-eval",
    "packages/auth-client",
    "packages/coordination-plugin-sdk",
    "packages/format",
    "packages/portal-contracts",
    "packages/portal-plugin-sdk",
    "packages/problem-cost",
    "packages/problem-runtime",
    "packages/problem-sdk",
    "packages/problem-test-harness",
    "packages/saml-utils",
    "packages/security-harness",
    "packages/standalone-cli",
    "packages/tcloud",
    "packages/trust-bridge",
    "packages/web-kit",
  ];

  const allWorkspaces = ["infrastructure", ...appsAlphabetical, ...packagesAlphabetical];

  it("should discover exactly 21 workspaces from the root package.json", () => {
    expect(workspaces).toHaveLength(21);
    expect(workspaces.map((w) => w.dir).sort()).toEqual([...allWorkspaces].sort());
  });

  it("should plan build as infrastructure + every apps/* workspace (packages/* excluded)", () => {
    const plan = planTask("build", workspaces);
    expect(plan.included.map((w) => w.dir)).toEqual(["infrastructure", ...appsAlphabetical]);
  });

  it("should plan typecheck across every workspace", () => {
    const plan = planTask("typecheck", workspaces);
    expect(plan.included.map((w) => w.dir)).toEqual(allWorkspaces);
  });

  it("should plan test across every workspace", () => {
    const plan = planTask("test", workspaces);
    expect(plan.included.map((w) => w.dir)).toEqual(allWorkspaces);
  });
});

/**
 * `--jobs` exists because the serial chain left a 4-core CI runner mostly idle: `typecheck` spent
 * 51.9s of wall time for 1m33s of CPU, i.e. under two cores busy, since one `tsc --noEmit` cannot
 * use more than one. The default stays 1 so a developer's terminal keeps its readable, fail-fast
 * output; CI opts in.
 */
describe("parseJobs", () => {
  it("should default to 1 (serial) when no --jobs is given", () => {
    expect(parseJobs([])).toBe(1);
  });

  it("should accept both --jobs <n> and --jobs=<n>", () => {
    expect(parseJobs(["--jobs", "4"])).toBe(4);
    expect(parseJobs(["--jobs=4"])).toBe(4);
  });

  it("should reject a non-positive, non-numeric, or missing value", () => {
    expect(() => parseJobs(["--jobs", "0"])).toThrow(UsageError);
    expect(() => parseJobs(["--jobs", "-2"])).toThrow(UsageError);
    expect(() => parseJobs(["--jobs", "many"])).toThrow(UsageError);
    expect(() => parseJobs(["--jobs"])).toThrow(UsageError);
  });

  it("should reject an unknown argument instead of silently ignoring it", () => {
    expect(() => parseJobs(["--parallel", "4"])).toThrow(UsageError);
  });
});
