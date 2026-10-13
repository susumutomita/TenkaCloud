import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  indexImports,
  planChangedTests,
  readImportIndex,
  readWorkspaceNodes,
  type WorkspaceNode,
} from "./test-changed";

const workspaces: WorkspaceNode[] = [
  { dir: "infrastructure", name: "@x/infra", hasTest: true, workspaceDeps: ["@x/contracts"] },
  { dir: "apps/console", name: "@x/console", hasTest: true, workspaceDeps: ["@x/kit"] },
  { dir: "packages/contracts", name: "@x/contracts", hasTest: true, workspaceDeps: [] },
  { dir: "packages/kit", name: "@x/kit", hasTest: false, workspaceDeps: ["@x/contracts"] },
  { dir: "packages/unrelated", name: "@x/unrelated", hasTest: true, workspaceDeps: [] },
];
const noImports = indexImports([], workspaces);

function selected(paths: string[], imports = noImports) {
  const plan = planChangedTests(paths, workspaces, imports);
  if (plan.kind === "all") return { all: plan.reason };
  return { suites: plan.suites, workspaces: plan.workspaces };
}

describe("planChangedTests routing", () => {
  it("runs no test for Claude Code settings alone", () => {
    expect(selected([".claude/settings.json"])).toEqual({ suites: [], workspaces: [] });
  });

  it("runs only the host suite for a host source file", () => {
    expect(selected(["scripts/local-host/build.ts"])).toEqual({ suites: ["host"], workspaces: [] });
  });

  it("runs every test for dependency, toolchain, hook, runner and catalog changes", () => {
    for (const path of [
      "package.json",
      "bun.lock",
      "tsconfig.host.json",
      "Makefile",
      "mise.toml",
      "problems",
      ".husky/pre-commit",
      "scripts/workspace/run-workspaces.ts",
    ]) {
      expect(selected(["docs/x.md", path])).toEqual({ all: path });
    }
  });

  it("runs every test for a path no route claims", () => {
    expect(selected(["LICENSE"])).toEqual({ all: "LICENSE" });
    expect(selected(["docker/host/Dockerfile"])).toEqual({ all: "docker/host/Dockerfile" });
  });

  it("routes documents, workflows and generated sites to the script suite that reads them", () => {
    for (const path of [
      "README.md",
      "docs/local-hosting.md",
      "landing/index.html",
      "release/host-candidate.json",
      ".github/workflows/ci.yml",
      ".vscode/tasks.json",
      "knip.json",
    ]) {
      expect(selected([path])).toEqual({ suites: ["scripts"], workspaces: [] });
    }
  });

  it("routes host, integration, authoring and pack paths to their suites", () => {
    expect(selected(["scripts/lib/a.ts", "integrations/ctfd/runtime.py"])).toEqual({
      suites: ["host"],
      workspaces: [],
    });
    expect(selected(["scripts/problem-pack/a.ts", "packs/golden/README.md"])).toEqual({
      suites: ["authoring"],
      workspaces: [],
    });
  });

  it("keeps both sides of a rename", () => {
    expect(selected(["apps/console/src/old.ts", "scripts/release/new.ts"])).toEqual({
      suites: ["scripts"],
      workspaces: ["apps/console"],
    });
  });
});

describe("planChangedTests workspace dependencies", () => {
  it("runs a changed package and every workspace that depends on it, directly or not", () => {
    expect(selected(["packages/contracts/src/a.ts"])).toEqual({
      suites: [],
      workspaces: ["infrastructure", "apps/console", "packages/contracts"],
    });
  });

  it("does not run a workspace without a test script, but still follows its dependents", () => {
    expect(selected(["packages/kit/src/a.ts"])).toEqual({
      suites: [],
      workspaces: ["apps/console"],
    });
  });

  it("runs only the application for an application change", () => {
    expect(selected(["apps/console/src/a.ts"])).toEqual({
      suites: [],
      workspaces: ["apps/console"],
    });
  });
});

describe("planChangedTests root-suite imports", () => {
  const imports = indexImports(
    [
      ["scripts/local-host/tests/a.test.ts", 'import { check } from "../../quality/check";'],
      ["scripts/quality/check.ts", 'export * from "./rules.ts";'],
      ["scripts/problem-pack/pack.ts", 'import { contract } from "@x/contracts/schema";'],
      ["scripts/local-host/app.ts", 'import { view } from "../../apps/console/src/view";'],
      ["scripts/release/plan.ts", 'const lib = await import("../lib");'],
    ],
    workspaces,
  );

  it("runs a suite whose files import the changed root-suite file", () => {
    expect(selected(["scripts/quality/check.ts"], imports)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("follows imports through other root-suite files", () => {
    expect(selected(["scripts/quality/rules.ts"], imports)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("resolves a directory import to its index file", () => {
    expect(selected(["scripts/lib/index.ts"], imports)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("runs a suite that imports a changed package by name", () => {
    expect(selected(["packages/contracts/src/a.ts"], imports)).toEqual({
      suites: ["authoring"],
      workspaces: ["infrastructure", "apps/console", "packages/contracts"],
    });
  });

  it("does not follow root-suite imports of an application", () => {
    expect(selected(["apps/console/src/view.ts"], imports)).toEqual({
      suites: [],
      workspaces: ["apps/console"],
    });
  });
});

describe("planChangedTests on this repository", () => {
  const root = join(import.meta.dir, "../..");
  const repoWorkspaces = readWorkspaceNodes(root);
  const repoImports = readImportIndex(root, repoWorkspaces);

  function repoPlan(paths: string[]) {
    const plan = planChangedTests(paths, repoWorkspaces, repoImports);
    return plan.kind === "all"
      ? { all: plan.reason }
      : { suites: plan.suites, workspaces: plan.workspaces };
  }

  it("meets the issue's acceptance rows", () => {
    expect(repoPlan([".claude/settings.json"])).toEqual({ suites: [], workspaces: [] });
    expect(repoPlan(["scripts/local-host/build.ts"])).toEqual({ suites: ["host"], workspaces: [] });
    expect(repoPlan(["package.json"])).toEqual({ all: "package.json" });
    expect(repoPlan(["bun.lock"])).toEqual({ all: "bun.lock" });
  });

  it("runs the host suite when the import-closure rules change", () => {
    expect(repoPlan(["scripts/quality/host-imports.ts"])).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("runs every consumer of the public contracts package", () => {
    expect(repoPlan(["packages/portal-contracts/src/skill-evidence.ts"])).toEqual({
      suites: ["scripts", "authoring", "host"],
      workspaces: [
        "infrastructure",
        "apps/application-admin-console",
        "apps/developer-portal",
        "apps/participant-portal",
        "packages/portal-contracts",
        "packages/problem-sdk",
        "packages/problem-test-harness",
        "packages/web-kit",
      ],
    });
  });
});
