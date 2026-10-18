import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  indexReferences,
  planChangedTests,
  type ReferenceIndex,
  readReferenceIndex,
  readWorkspaceNodes,
  repositoryFiles,
  type WorkspaceNode,
} from "./test-changed";

const workspaces: WorkspaceNode[] = [
  { dir: "infrastructure", name: "@x/infra", hasTest: true, workspaceDeps: ["@x/contracts"] },
  { dir: "apps/console", name: "@x/console", hasTest: true, workspaceDeps: ["@x/kit"] },
  { dir: "apps/portal", name: "@x/portal", hasTest: true, workspaceDeps: [] },
  { dir: "packages/contracts", name: "@x/contracts", hasTest: true, workspaceDeps: [] },
  { dir: "packages/kit", name: "@x/kit", hasTest: false, workspaceDeps: ["@x/contracts"] },
  { dir: "packages/unrelated", name: "@x/unrelated", hasTest: true, workspaceDeps: [] },
];

function referencesFrom(
  sources: Record<string, string>,
  otherFiles: string[] = [],
): ReferenceIndex {
  const tracked = new Set([...Object.keys(sources), ...otherFiles]);
  return indexReferences(Object.entries(sources), workspaces, tracked);
}

const noReferences = referencesFrom({});

function selected(paths: string[], references = noReferences) {
  const plan = planChangedTests(paths, workspaces, references);
  if (plan.kind === "all") return { all: plan.reason };
  return { suites: plan.suites, workspaces: plan.workspaces };
}

describe("planChangedTests routing", () => {
  it("runs no test for Claude Code settings alone", () => {
    expect(selected([".claude/settings.json"])).toEqual({ suites: [], workspaces: [] });
  });

  it("runs only the host suite for a host source file nothing references", () => {
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
      "docs/architecture/README.md",
      "landing/index.html",
      "release/host-candidate.json",
      ".github/workflows/ci.yml",
      ".vscode/tasks.json",
      "knip.json",
    ]) {
      expect(selected([path])).toEqual({ suites: ["scripts"], workspaces: [] });
    }
  });

  it("routes host, integration and authoring paths to their suites", () => {
    expect(selected(["scripts/lib/a.ts", "integrations/ctfd/runtime.py"])).toEqual({
      suites: ["host"],
      workspaces: [],
    });
    expect(selected(["scripts/problem-pack/a.ts", "scripts/onboarding/a.ts"])).toEqual({
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

  it("runs the script suite for a workspace manifest, which its tests scan by directory", () => {
    expect(selected(["packages/unrelated/package.json"])).toEqual({
      suites: ["scripts"],
      workspaces: ["packages/unrelated"],
    });
  });

  it("does not run a workspace without a test script, but still follows its dependents", () => {
    expect(selected(["packages/kit/src/a.ts"])).toEqual({
      suites: [],
      workspaces: ["apps/console"],
    });
  });
});

describe("planChangedTests references", () => {
  const references = referencesFrom(
    {
      "scripts/local-host/tests/a.test.ts": 'import { check } from "../../quality/check";',
      "scripts/quality/check.ts": 'export * from "./rules.ts";',
      "scripts/quality/rules.ts": "export const rules = [];",
      "scripts/problem-pack/pack.ts": 'import { contract } from "@x/contracts/schema";',
      "scripts/local-host/app.ts": 'import { view } from "../../apps/console/src/view";',
      "apps/console/src/view.ts": 'export { x } from "./model.js";',
      "apps/console/src/model.ts": "export const x = 1;",
      "apps/console/src/other.ts": "export const y = 2;",
      "scripts/release/plan.ts": 'const lib = await import("../lib");',
      "scripts/lib/index.ts": "export {};",
      "infrastructure/test/launcher.test.ts":
        'readFileSync(resolve(import.meta.dirname, "../../release/launcher-defaults.json"));',
      "infrastructure/test/names.test.ts":
        'const NAMES = resolve(__dirname, "..", "..", "scripts", "lib", "names.sh");',
      "infrastructure/test/schema.test.ts":
        'import { schema } from "../../scripts/cloud-hosting/schema";',
      "scripts/cloud-hosting/schema.ts": "export const schema = {};",
      "apps/portal/test/spec.test.ts": 'readFileSync(resolve(ROOT, "docs/api/spec.json"));',
      "apps/portal/test/eval.test.ts":
        'Bun.spawn(["bun", "-e", `import { m } from "./scripts/local-host/model";`]);',
      "scripts/local-host/model.ts": "export const m = 1;",
      "apps/portal/src/catalog.tsx":
        'import { Authors } from "../../../packages/unrelated/src/authors";',
      "packages/unrelated/src/authors.tsx": "export const Authors = () => null;",
    },
    ["release/launcher-defaults.json", "scripts/lib/names.sh", "docs/api/spec.json"],
  );

  it("runs a suite whose files import the changed file", () => {
    expect(selected(["scripts/quality/check.ts"], references)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("follows imports through other files", () => {
    expect(selected(["scripts/quality/rules.ts"], references)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
    expect(selected(["apps/console/src/model.ts"], references)).toEqual({
      suites: ["host"],
      workspaces: ["apps/console"],
    });
  });

  it("runs an application alone when nothing outside it references the changed file", () => {
    expect(selected(["apps/console/src/other.ts"], references)).toEqual({
      suites: [],
      workspaces: ["apps/console"],
    });
  });

  it("resolves a directory import to its index file", () => {
    expect(selected(["scripts/lib/index.ts"], references)).toEqual({
      suites: ["scripts", "host"],
      workspaces: [],
    });
  });

  it("runs a suite that imports a changed package by name", () => {
    expect(selected(["packages/contracts/src/a.ts"], references)).toEqual({
      suites: ["authoring"],
      workspaces: ["infrastructure", "apps/console", "packages/contracts"],
    });
  });

  it("runs a workspace whose tests read a root file by a quoted path", () => {
    expect(selected(["release/launcher-defaults.json"], references)).toEqual({
      suites: ["scripts"],
      workspaces: ["infrastructure"],
    });
  });

  it("runs a workspace whose tests build a root path from quoted segments", () => {
    expect(selected(["scripts/lib/names.sh"], references)).toEqual({
      suites: ["host"],
      workspaces: ["infrastructure"],
    });
  });

  it("runs a workspace whose tests import a root-suite module", () => {
    expect(selected(["scripts/cloud-hosting/schema.ts"], references)).toEqual({
      suites: ["scripts"],
      workspaces: ["infrastructure"],
    });
  });

  it("resolves repository-relative paths, including code passed to `bun -e`", () => {
    expect(selected(["docs/api/spec.json"], references)).toEqual({
      suites: ["scripts"],
      workspaces: ["apps/portal"],
    });
    expect(selected(["scripts/local-host/model.ts"], references)).toEqual({
      suites: ["host"],
      workspaces: ["apps/portal"],
    });
  });

  it("ignores paths named only in comments", () => {
    const commented = referencesFrom({
      "apps/portal/src/client.ts": [
        "/**",
        " * Mirrors scripts/local-host/model.ts; see ../../../scripts/local-host/model.ts.",
        " */",
        '// import { m } from "../../../scripts/local-host/model";',
        "export const client = 1;",
      ].join("\n"),
      "scripts/local-host/model.ts": "export const m = 1;",
    });
    expect(selected(["scripts/local-host/model.ts"], commented)).toEqual({
      suites: ["host"],
      workspaces: [],
    });
  });

  it("runs a workspace that imports another by relative path without declaring it", () => {
    expect(selected(["packages/unrelated/src/authors.tsx"], references)).toEqual({
      suites: [],
      workspaces: ["apps/portal", "packages/unrelated"],
    });
  });
});

describe("planChangedTests on this repository", () => {
  const root = join(import.meta.dir, "../..");
  const repoWorkspaces = readWorkspaceNodes(root);
  const repoFiles = repositoryFiles(root);

  function repoPlan(paths: string[], files = repoFiles) {
    const plan = planChangedTests(
      paths,
      repoWorkspaces,
      readReferenceIndex(root, repoWorkspaces, files, paths),
    );
    return plan.kind === "all"
      ? { all: plan.reason, suites: [], workspaces: [] }
      : { all: undefined, suites: plan.suites, workspaces: plan.workspaces };
  }

  it("meets the issue's acceptance rows", () => {
    expect(repoPlan([".claude/settings.json"])).toEqual({
      all: undefined,
      suites: [],
      workspaces: [],
    });
    expect(repoPlan(["package.json"]).all).toBe("package.json");
    expect(repoPlan(["bun.lock"]).all).toBe("bun.lock");
    expect(repoPlan(["scripts/local-host/build.ts"]).suites).toContain("host");
  });

  it("runs the infrastructure tests that read root files", () => {
    for (const path of ["release/launcher-defaults.json", "scripts/lib/names.sh"]) {
      expect(repoPlan([path]).workspaces).toContain("infrastructure");
    }
  });

  it("still selects the importers of a file whose deletion or rename is staged", () => {
    const deleted = "packages/web-kit/src/ProblemAuthors.tsx";
    const remaining = repoFiles.filter((file) => file !== deleted);
    expect(repoPlan([deleted], remaining).workspaces).toEqual(
      expect.arrayContaining(["apps/application-admin-console", "apps/participant-portal"]),
    );
  });

  it("runs the landing checks for developer-portal docs", () => {
    expect(
      repoPlan(["apps/developer-portal/src/app/developers/docs/manual/developer/page.ja.mdx"]),
    ).toEqual({ all: undefined, suites: ["scripts"], workspaces: ["apps/developer-portal"] });
  });

  it("runs every declared consumer of the public contracts package", () => {
    const plan = repoPlan(["packages/portal-contracts/src/skill-evidence.ts"]);
    expect(plan.suites).toEqual(expect.arrayContaining(["authoring", "host"]));
    expect(plan.workspaces).toEqual(
      expect.arrayContaining([
        "infrastructure",
        "apps/application-admin-console",
        "apps/developer-portal",
        "apps/participant-portal",
        "packages/portal-contracts",
        "packages/problem-sdk",
        "packages/problem-test-harness",
        "packages/web-kit",
      ]),
    );
  });
});
