import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildChildEnvironment,
  buildLaunchSpecs,
  findMissingPrerequisites,
  FleetConfigError,
  type FleetConfig,
  type FleetRepository,
  loadFleet,
  parseCliArguments,
  parseFleetConfig,
  renderLaunchPlan,
  selectRepositories,
  validateFleet,
  validateWorkflowText,
} from "./symphony-fleet";

const platform: FleetRepository = {
  id: "platform",
  repository: "susumutomita/TenkaCloud",
  workflow: ".symphony/workflows/platform.WORKFLOW.md",
  workspace: "platform",
  port: 4311,
};

const simulator: FleetRepository = {
  id: "simulator",
  repository: "susumutomita/TenkaCloudSimulator",
  workflow: ".symphony/workflows/simulator.WORKFLOW.md",
  workspace: "simulator",
  port: 4312,
};

const config: FleetConfig = {
  schemaVersion: 1,
  defaultBinary: "symphony",
  workspaceRootEnv: "SYMPHONY_WORKSPACE_ROOT",
  logsRootEnv: "SYMPHONY_LOGS_ROOT",
  repositories: [platform, simulator],
};

function workflowFor(repository: FleetRepository): string {
  return `---
tracker:
  kind: github
  provider:
    repo: ${repository.repository}
    token: $GITHUB_TOKEN
  required_labels:
    - agent:ready
  active_states:
    - open
  terminal_states:
    - closed
workspace:
  root: $SYMPHONY_WORKSPACE_ROOT
hooks:
  after_create: |
    git clone --filter=blob:none --no-tags git@github.com:${repository.repository}.git .
    make install_ci
agent:
  max_concurrent_agents: 1
codex:
  approval_policy: never
  thread_sandbox: workspace-write
---
Run make agent-gate.
Run codex exec review --base origin/main and resolve actionable findings.
Never run deploy, destroy, release, force-push, or secret-management commands.
`;
}

describe("parseFleetConfig", () => {
  it("should parse a valid fleet manifest", () => {
    expect(parseFleetConfig(config)).toEqual(config);
  });

  it("should reject an unknown schema version", () => {
    expect(() => parseFleetConfig({ ...config, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it("should reject an empty repository list", () => {
    expect(() => parseFleetConfig({ ...config, repositories: [] })).toThrow(/non-empty array/);
  });

  it("should reject a non-integer port", () => {
    expect(() =>
      parseFleetConfig({
        ...config,
        repositories: [{ ...platform, port: 4311.5 }],
      }),
    ).toThrow(/port/);
  });
});

describe("workflow validation", () => {
  it("should accept the required GitHub, isolation, gate, review, and safety contract", () => {
    expect(() => validateWorkflowText(config, platform, workflowFor(platform))).not.toThrow();
  });

  it("should reject a workflow scoped to another repository", () => {
    const source = workflowFor(platform).replace(
      "repo: susumutomita/TenkaCloud",
      "repo: susumutomita/Other",
    );
    expect(() => validateWorkflowText(config, platform, source)).toThrow(/provider\.repo/);
  });

  it("should reject a workflow without an independent review", () => {
    const source = workflowFor(platform).replace(
      "Run codex exec review --base origin/main and resolve actionable findings.\n",
      "",
    );
    expect(() => validateWorkflowText(config, platform, source)).toThrow(/independent Codex review/);
  });

  it("should reject a workflow that omits the destructive-action boundary", () => {
    const source = workflowFor(platform).replace(
      "Never run deploy, destroy, release, force-push, or secret-management commands.\n",
      "",
    );
    expect(() => validateWorkflowText(config, platform, source)).toThrow(
      /destructive-action boundary/,
    );
  });
});

describe("fleet filesystem validation", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "symphony-fleet-"));
    for (const repository of config.repositories) {
      const path = join(fixtureRoot, repository.workflow);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, workflowFor(repository), "utf8");
    }
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("should load and validate a complete manifest", async () => {
    const manifestPath = ".symphony/fleet.json";
    mkdirSync(join(fixtureRoot, ".symphony"), { recursive: true });
    writeFileSync(join(fixtureRoot, manifestPath), JSON.stringify(config), "utf8");

    const loaded = await loadFleet(fixtureRoot, manifestPath);
    await expect(validateFleet(loaded, fixtureRoot)).resolves.toBeUndefined();
  });

  it("should reject duplicate ports before processes are launched", async () => {
    const duplicatePort: FleetConfig = {
      ...config,
      repositories: [platform, { ...simulator, port: platform.port }],
    };

    await expect(validateFleet(duplicatePort, fixtureRoot)).rejects.toThrow(/port 4311 is shared/);
  });

  it("should reject a missing workflow", async () => {
    const missing: FleetConfig = {
      ...config,
      repositories: [{ ...platform, workflow: ".symphony/workflows/missing.WORKFLOW.md" }],
    };

    await expect(validateFleet(missing, fixtureRoot)).rejects.toThrow(/not readable/);
  });
});

describe("CLI and repository selection", () => {
  it("should parse both repository flag forms", () => {
    expect(parseCliArguments(["run", "--repo", "platform", "--repo=simulator"])).toEqual({
      command: "run",
      repositoryIds: ["platform", "simulator"],
    });
  });

  it("should reject unknown arguments", () => {
    expect(() => parseCliArguments(["run", "--all"])).toThrow(/unknown argument/);
  });

  it("should reject unknown and duplicate repository selections", () => {
    expect(() => selectRepositories(config, ["unknown"])).toThrow(/unknown repository/);
    expect(() => selectRepositories(config, ["platform", "platform"])).toThrow(/more than once/);
  });
});

describe("launch planning", () => {
  const environment = {
    GITHUB_TOKEN: "secret-value-that-must-never-be-reported",
    SYMPHONY_BIN: "/tools/symphony",
    SYMPHONY_WORKSPACE_ROOT: "/work/symphony",
    SYMPHONY_LOGS_ROOT: "/logs/symphony",
  };

  it("should report missing prerequisite names without secret values", () => {
    const missing = findMissingPrerequisites(
      config,
      { GITHUB_TOKEN: "do-not-print", SYMPHONY_WORKSPACE_ROOT: "relative" },
      (command) => (command === "git" ? "/usr/bin/git" : null),
    );

    expect(missing).toContain("SYMPHONY_WORKSPACE_ROOT (must be absolute)");
    expect(missing).toContain("command:symphony");
    expect(missing).toContain("command:codex");
    expect(missing).toContain("command:ssh");
    expect(missing.join(" ")).not.toContain("do-not-print");
  });

  it("should create one isolated process specification per selected repository", () => {
    const specs = buildLaunchSpecs(config, "/repo", environment, ["simulator"]);

    expect(specs).toEqual([
      {
        id: "simulator",
        repository: "susumutomita/TenkaCloudSimulator",
        logsRoot: "/logs/symphony/simulator",
        port: 4312,
        workspaceRoot: "/work/symphony/simulator",
        workspaceRootEnv: "SYMPHONY_WORKSPACE_ROOT",
        command: [
          "/tools/symphony",
          "/repo/.symphony/workflows/simulator.WORKFLOW.md",
          "--port",
          "4312",
          "--logs-root",
          "/logs/symphony/simulator",
        ],
      },
    ]);
  });

  it("should override only the child workspace root and drop undefined environment values", () => {
    const [spec] = buildLaunchSpecs(config, "/repo", environment, ["platform"]);
    if (spec === undefined) throw new FleetConfigError("platform launch spec is missing");

    expect(
      buildChildEnvironment(
        { GITHUB_TOKEN: "token", OPTIONAL_UNSET: undefined, SYMPHONY_WORKSPACE_ROOT: "/fleet" },
        spec,
      ),
    ).toEqual({
      GITHUB_TOKEN: "token",
      SYMPHONY_WORKSPACE_ROOT: "/work/symphony/platform",
    });
  });

  it("should render a plan without requiring credentials or installed commands", () => {
    const plan = renderLaunchPlan(config, "/repo", ["platform"]);

    expect(plan).toContain("[platform] susumutomita/TenkaCloud");
    expect(plan).toContain("/repo/.symphony/workflows/platform.WORKFLOW.md");
    expect(plan).toContain("child $SYMPHONY_WORKSPACE_ROOT: $SYMPHONY_WORKSPACE_ROOT/platform");
    expect(plan).not.toContain("secret-value-that-must-never-be-reported");
  });
});
