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

  it("should offer the official macOS Turso install when the CLI is missing", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not found" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "susumu", stderr: "" });

    const confirm = vi
      .fn<(question: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      runTursoLiveCommand(
        [],
        { ENV: "development" },
        {
          repoRoot: "/repo",
          processRunner: { run },
          interactive: true,
          platform: "darwin",
          confirm,
          prompt: vi.fn(async () => ""),
          log: vi.fn(),
        },
      ),
    ).resolves.toBe(1);
    expect(run).toHaveBeenCalledWith("brew", ["install", "tursodatabase/tap/turso"], {
      inherit: true,
    });
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
    expect(tenkaCloudUsage()).toContain("tenkacloud local");
    expect(tenkaCloudUsage()).toContain("doctor");
    expect(tenkaCloudUsage()).toContain("onboard");
    expect(tenkaCloudUsage()).toContain("turso-live");
  });
});
