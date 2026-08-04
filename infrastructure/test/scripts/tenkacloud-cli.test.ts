import { describe, expect, it, vi } from "vitest";
import {
  type LocalCommandDeps,
  parseLocalCommand,
  runLocalCommand,
} from "../../../scripts/cli/local-command";
import { runTursoLiveCommand } from "../../../scripts/cli/turso-live-command";
import { tenkaCloudUsage } from "../../../scripts/tenkacloud";

function localDeps(overrides: Partial<LocalCommandDeps> = {}): LocalCommandDeps {
  return {
    repoRoot: "/repo",
    processRunner: { run: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) },
    runLocal: vi.fn(async () => {}),
    fileExists: vi.fn(() => true),
    log: vi.fn(),
    isPortFree: vi.fn(async () => true),
    ...overrides,
  };
}

describe("TenkaCloud CLI (#2633)", () => {
  it("should make SQLite the explicit local default", () => {
    expect(parseLocalCommand([])).toMatchObject({ database: "sqlite" });
    expect(parseLocalCommand(["--database", "turso", "--problem", "hello"])).toMatchObject({
      database: "turso",
      problem: "hello",
    });
    expect(() => parseLocalCommand(["--database", "dynamodb"])).toThrow("sqlite or turso");
  });

  it("should start the API and portal from one local command", async () => {
    const calls: string[][] = [];
    const deps = localDeps({
      runLocal: vi.fn(async (args) => {
        calls.push([...args]);
        if (args[0] === "status") throw new Error("not running");
      }),
    });

    await expect(runLocalCommand(["--problem", "hello"], deps)).resolves.toBe(0);
    expect(calls).toEqual([["status"], ["up", "hello"]]);
    expect(deps.processRunner.run).toHaveBeenCalledWith(
      "bun",
      ["run", "dev", "--host", "127.0.0.1"],
      expect.objectContaining({ cwd: "/repo/apps/participant-portal", inherit: true }),
    );
  });

  it("should keep local subcommands available without starting the portal", async () => {
    const deps = localDeps();

    await expect(runLocalCommand(["list"], deps)).resolves.toBe(0);
    expect(deps.runLocal).toHaveBeenCalledWith(["list"]);
    expect(deps.processRunner.run).not.toHaveBeenCalled();
  });

  // [#2872] `up` starts the API and records ownership in state.json. Discovering the port
  // collision after that left the API running behind a command that exited non-zero, and the
  // next `make local` then refused with "already running" — the failure that actually
  // happened, caused by a dev server whose git worktree had already been deleted.
  it("should refuse before starting the API when the portal port is taken", async () => {
    const calls: string[][] = [];
    const deps = localDeps({
      isPortFree: vi.fn(async () => false),
      runLocal: vi.fn(async (args) => {
        calls.push([...args]);
        if (args[0] === "status") throw new Error("not running");
      }),
    });

    await expect(runLocalCommand([], deps)).resolves.toBe(1);
    expect(calls).not.toContainEqual(["up", ""]);
    expect(deps.processRunner.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("lsof -nP -iTCP:5175"));
  });

  it("should stop the API it started when the portal fails anyway", async () => {
    const calls: string[][] = [];
    const deps = localDeps({
      processRunner: { run: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) },
      runLocal: vi.fn(async (args) => {
        calls.push([...args]);
        if (args[0] === "status") throw new Error("not running");
      }),
    });

    await expect(runLocalCommand([], deps)).resolves.toBe(1);
    // `make local` promises "API and portal"; a half-session is what wedges the next run.
    expect(calls).toEqual([["status"], ["up", ""], ["down"]]);
  });

  it("should leave an API it did not start alone when the portal fails", async () => {
    // `local portal` attaches to a session someone else owns — tearing that down on a portal
    // failure would stop containers the operator is still using.
    const calls: string[][] = [];
    const deps = localDeps({
      processRunner: { run: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) },
      runLocal: vi.fn(async (args) => {
        calls.push([...args]);
      }),
    });

    await expect(runLocalCommand(["portal"], deps)).resolves.toBe(1);
    expect(calls).toEqual([["status"]]);
  });

  it("should install the pinned official Turso binary when the CLI is missing", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not found" })
      .mockReturnValueOnce({ status: 0, stdout: "turso 1.0.29", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "susumu", stderr: "" });

    const confirm = vi
      .fn<(question: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const installTursoCli = vi.fn(() => "/home/test/.turso/turso");
    await expect(
      runTursoLiveCommand(
        [],
        { ENV: "development" },
        {
          repoRoot: "/repo",
          processRunner: { run },
          interactive: true,
          platform: "darwin",
          architecture: "arm64",
          homeDirectory: "/home/test",
          installTursoCli,
          confirm,
          prompt: vi.fn(async () => ""),
          log: vi.fn(),
        },
      ),
    ).resolves.toBe(1);
    expect(installTursoCli).toHaveBeenCalledOnce();
    expect(run.mock.calls.some(([command]) => command === "brew")).toBe(false);
  });

  it("should give CodeBuild a non-interactive token path without mutating the image", async () => {
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: "not found" }));
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        [],
        { CI: "true", CODEBUILD_BUILD_ID: "build:1" },
        {
          repoRoot: "/repo",
          processRunner: { run },
          interactive: false,
          platform: "linux",
          architecture: "x64",
          homeDirectory: "/home/codebuild",
          installTursoCli: vi.fn(() => "/home/codebuild/.turso/turso"),
          confirm: vi.fn(async () => false),
          prompt: vi.fn(async () => ""),
          log,
        },
      ),
    ).resolves.toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("TURSO_API_TOKEN");
  });

  it("should require an exact interactive confirmation before a live deploy", async () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const env = {
      ENV: "development",
      AWS_ACCOUNT_ID: "123456789012",
      AWS_REGION: "ap-northeast-1",
      CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
      CDK_PARAM_TURSO_DATABASE_URL: "https://example.turso.io",
      CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/development/turso/auth-token",
      CDK_PARAM_FEATURES: '{"samlSso":true}',
    };
    const base = {
      repoRoot: "/repo",
      processRunner: { run },
      interactive: true,
      platform: "darwin" as const,
      architecture: "arm64" as const,
      homeDirectory: "/home/test",
      installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
      confirm: vi.fn(async () => true),
      log: vi.fn(),
    };

    await expect(
      runTursoLiveCommand(["deploy"], env, {
        ...base,
        prompt: vi.fn(async () => "yes"),
      }),
    ).resolves.toBe(1);
    expect(run).not.toHaveBeenCalled();

    await expect(
      runTursoLiveCommand(["deploy"], env, {
        ...base,
        prompt: vi.fn(async () => "deploy"),
      }),
    ).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith("make", ["deploy", "ENV=development"], { inherit: true });
  });

  it("should expose local, doctor, and live verification through one help screen", () => {
    const usage = tenkaCloudUsage();

    expect(usage).toContain("tenkacloud local");
    expect(usage).toContain("doctor");
    expect(usage).toContain("onboard");
    expect(usage).toContain("turso-live");
    expect(usage).not.toMatch(/(?:Issue\s*)?#\d+/);
  });
});
