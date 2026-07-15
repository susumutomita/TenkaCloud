import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "../../../scripts/cli/process";
import { runTursoLiveCommand } from "../../../scripts/cli/turso-live-command";

const SUCCESS = { status: 0, stdout: "", stderr: "" } as const;

class WizardCommandFixture {
  readonly calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
  readonly runner: ProcessRunner = {
    run: (command, args, options = {}) => {
      this.calls.push({ command, args, input: options.input });
      const result =
        this.turso(command, args) ?? this.aws(command, args) ?? this.make(command, args);
      if (!result) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      return result;
    },
  };
  databaseExists = false;
  parameterExists = false;
  tokenFailure = false;

  private turso(command: string, args: readonly string[]): ProcessResult | undefined {
    if (command !== "turso") return undefined;
    if (args[0] === "--version") return SUCCESS;
    if (args[0] === "auth" && args[1] === "whoami") {
      return { ...SUCCESS, stdout: "owner\n" };
    }
    if (args[0] !== "db") return undefined;
    if (args[1] === "show") {
      return this.databaseExists
        ? { ...SUCCESS, stdout: "https://tenkacloud-lite-owner.turso.io\n" }
        : { status: 1, stdout: "", stderr: "not found" };
    }
    if (args[1] === "create") {
      this.databaseExists = true;
      return SUCCESS;
    }
    if (args[1] === "tokens" && args[2] === "create") {
      if (this.tokenFailure) {
        return { status: 1, stdout: "partially-created-secret", stderr: "failed" };
      }
      return { ...SUCCESS, stdout: "test-token-never-print\n" };
    }
    return undefined;
  }

  private aws(command: string, args: readonly string[]): ProcessResult | undefined {
    if (command !== "aws") return undefined;
    if (args[0] === "--version") return SUCCESS;
    if (args[0] === "sts") return { ...SUCCESS, stdout: "123456789012\n" };
    if (args[0] === "ssm" && args[1] === "describe-parameters") {
      return { ...SUCCESS, stdout: this.parameterExists ? "SecureString\n" : "None\n" };
    }
    if (args[0] === "ssm" && args[1] === "put-parameter") {
      this.parameterExists = true;
      return SUCCESS;
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
      return { ...SUCCESS, stdout: "CREATE_COMPLETE\n" };
    }
    if (args[0] === "cloudformation" && args[1] === "list-stack-resources") {
      return { ...SUCCESS, stdout: "0\n" };
    }
    return undefined;
  }

  private make(command: string, args: readonly string[]): ProcessResult | undefined {
    return command === "make" && args[0] === "deploy" ? SUCCESS : undefined;
  }
}

describe("TenkaCloud Turso live wizard (#2617)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repoRoot(): { root: string; envPath: string } {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-turso-wizard-"));
    roots.push(root);
    const directory = join(root, "infrastructure", "environments", "development");
    mkdirSync(directory, { recursive: true });
    const envPath = join(directory, ".env");
    writeFileSync(
      envPath,
      [
        "TENANT_ADMIN_EMAIL=owner@example.com",
        "AWS_REGION=ap-northeast-1",
        'CDK_PARAM_FEATURES={"problemPacks":true}',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    return { root, envPath };
  }

  it("should run setup, preflight, exact-confirmed deploy, and zero-table verification", async () => {
    const { root, envPath } = repoRoot();
    const fixture = new WizardCommandFixture();
    const prompts = vi
      .fn<(question: string) => Promise<string>>()
      .mockResolvedValueOnce("") // default database name
      .mockResolvedValueOnce("deploy");
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        [],
        { ENV: "development" },
        {
          repoRoot: root,
          processRunner: fixture.runner,
          interactive: true,
          platform: "darwin",
          architecture: "arm64",
          homeDirectory: "/home/test",
          installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
          confirm: vi.fn(async () => true),
          prompt: prompts,
          log,
        },
      ),
    ).resolves.toBe(0);

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("AWS_ACCOUNT_ID=123456789012");
    expect(content).toContain("CDK_PARAM_CONTROL_DATA_BACKEND=turso");
    expect(content).toContain(
      "CDK_PARAM_TURSO_DATABASE_URL=https://tenkacloud-lite-owner.turso.io",
    );
    expect(content).toContain(
      "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token",
    );
    expect(content).toContain('CDK_PARAM_FEATURES={"problemPacks":true,"samlSso":true}');
    expect(content).not.toContain("test-token-never-print");
    expect(log.mock.calls.flat().join("\n")).not.toContain("test-token-never-print");

    const secretWrite = fixture.calls.find(
      ({ command, args }) => command === "aws" && args.includes("put-parameter"),
    );
    expect(secretWrite?.args.join(" ")).not.toContain("test-token-never-print");
    expect(secretWrite?.args).toEqual(
      expect.arrayContaining(["--value", "file:///dev/stdin", "--type", "SecureString"]),
    );
    expect(secretWrite?.input).toBe("test-token-never-print");
    expect(fixture.calls).toContainEqual(
      expect.objectContaining({ command: "make", args: ["deploy", "ENV=development"] }),
    );
    expect(
      fixture.calls.filter(({ command, args }) =>
        `${command} ${args.join(" ")}`.includes("cloudformation list-stack-resources"),
      ),
    ).toHaveLength(2);
  });

  it("should load the selected .env before a direct read-only preflight", async () => {
    const { root, envPath } = repoRoot();
    writeFileSync(
      envPath,
      [
        "AWS_ACCOUNT_ID=123456789012",
        "AWS_REGION=ap-northeast-1",
        "CDK_PARAM_CONTROL_DATA_BACKEND=turso",
        "CDK_PARAM_TURSO_DATABASE_URL=https://example.turso.io",
        "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token",
        'CDK_PARAM_FEATURES={"samlSso":true}',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const run = vi.fn((command: string, args: readonly string[]) => {
      const joined = `${command} ${args.join(" ")}`;
      if (joined === "aws --version" || joined === "turso --version") return SUCCESS;
      if (joined.includes("sts get-caller-identity")) {
        return { ...SUCCESS, stdout: "123456789012\n" };
      }
      if (joined.includes("ssm describe-parameters")) {
        return { ...SUCCESS, stdout: "SecureString\n" };
      }
      throw new Error(`Unexpected command: ${joined}`);
    });

    await expect(
      runTursoLiveCommand(
        ["preflight"],
        { ENV: "development" },
        {
          repoRoot: root,
          processRunner: { run },
          interactive: false,
          platform: "darwin",
          architecture: "arm64",
          homeDirectory: "/home/test",
          installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
          confirm: vi.fn(async () => false),
          prompt: vi.fn(async () => ""),
          log: vi.fn(),
        },
      ),
    ).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith("aws", expect.arrayContaining(["sts", "get-caller-identity"]));
  });

  it("should redact command output if token generation fails", async () => {
    const { root } = repoRoot();
    const fixture = new WizardCommandFixture();
    fixture.tokenFailure = true;

    const result = runTursoLiveCommand(
      [],
      { ENV: "development" },
      {
        repoRoot: root,
        processRunner: fixture.runner,
        interactive: true,
        platform: "darwin",
        architecture: "arm64",
        homeDirectory: "/home/test",
        installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
        confirm: vi.fn(async () => true),
        prompt: vi.fn(async () => ""),
        log: vi.fn(),
      },
    );
    await expect(result).rejects.toThrow("command output redacted");
    await expect(result).rejects.not.toThrow("partially-created-secret");
  });

  it("should render the guide successfully without requiring an installed Turso CLI", async () => {
    const { root } = repoRoot();
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: "not found" }));
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["guide"],
        { ENV: "development" },
        {
          repoRoot: root,
          processRunner: { run },
          interactive: false,
          platform: "darwin",
          architecture: "arm64",
          homeDirectory: "/home/test",
          installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
          confirm: vi.fn(async () => false),
          prompt: vi.fn(async () => ""),
          log,
        },
      ),
    ).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("#2617 Turso 初回ライブ E2E"));
  });
});
