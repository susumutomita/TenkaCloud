import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "../../../scripts/cli/process";
import { runTursoLiveCommand } from "../../../scripts/cli/turso-live-command";

const SUCCESS = { status: 0, stdout: "", stderr: "" } as const;

const MS_PER_SECOND = 1000;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "EdDSA", typ: "JWT" }), encode(payload), "c2ln"].join(".");
}

function jwtExpiring(isoDate: string): string {
  return jwt({ id: "tenkacloud-lite", exp: Math.floor(Date.parse(isoDate) / MS_PER_SECOND) });
}

/** SSM に入っている「まだ十分に有効な」token。 preflight の期限チェックを通す。 */
const STORED_TOKEN = jwtExpiring("2099-01-01T00:00:00Z");

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
  /** SSM に保存済みの token 値 (decrypt 読み出しで返る想定)。 */
  storedToken = STORED_TOKEN;

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
    if (args[0] === "ssm" && args[1] === "get-parameter") {
      return { ...SUCCESS, stdout: `${this.storedToken}\n` };
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
    // #3051: 既定は Turso CLI と同じ無期限。30d 固定は 30 日後に全 Lambda を 401 にした。
    expect(
      fixture.calls.find(({ command, args }) => command === "turso" && args[2] === "create")?.args,
    ).toEqual(["db", "tokens", "create", "tenkacloud-lite", "--expiration", "never"]);
    expect(log.mock.calls.flat().join("\n")).not.toContain(STORED_TOKEN);
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
      if (joined.includes("ssm get-parameter")) {
        return { ...SUCCESS, stdout: `${STORED_TOKEN}\n` };
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Turso 初回ライブ E2E"));
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/(?:Issue\s*)?#\d+/));
  });

  it("should honor TURSO_TOKEN_EXPIRATION when a rotation schedule is wanted", async () => {
    const { root } = repoRoot();
    const fixture = new WizardCommandFixture();

    await expect(
      runTursoLiveCommand(
        [],
        { ENV: "development", TURSO_TOKEN_EXPIRATION: "45d" },
        {
          repoRoot: root,
          processRunner: fixture.runner,
          interactive: true,
          platform: "darwin",
          architecture: "arm64",
          homeDirectory: "/home/test",
          installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
          confirm: vi.fn(async () => true),
          prompt: vi
            .fn<(question: string) => Promise<string>>()
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("deploy"),
          log: vi.fn(),
        },
      ),
    ).resolves.toBe(0);

    expect(
      fixture.calls.find(({ command, args }) => command === "turso" && args[2] === "create")?.args,
    ).toContain("45d");
  });

  it("should refuse to reuse an expired SSM token and point at the rotate command", async () => {
    const { root } = repoRoot();
    const fixture = new WizardCommandFixture();
    fixture.parameterExists = true;
    fixture.storedToken = jwtExpiring("2020-05-06T00:00:00Z");
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
          prompt: vi.fn(async () => ""),
          log,
        },
      ),
    ).resolves.toBe(1);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("2020-05-06 に期限切れ");
    expect(output).toContain("make turso-token-rotate ENV=development");
    expect(output).not.toContain(fixture.storedToken);
    // 期限切れ token のまま deploy させない。
    expect(fixture.calls.some(({ args }) => args.includes("deploy"))).toBe(false);
  });
});

interface RotateCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

describe("tenkacloud turso-live rotate-token (#3051)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const DATABASE_HOST = "tenkacloud-lite-owner.turso.io";
  const ISSUED_TOKEN = jwtExpiring("2099-06-07T00:00:00Z");

  function rotateRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-turso-rotate-"));
    roots.push(root);
    const directory = join(root, "infrastructure", "environments", "development");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, ".env"),
      [
        "AWS_ACCOUNT_ID=123456789012",
        "AWS_REGION=ap-northeast-1",
        "CDK_PARAM_CONTROL_DATA_BACKEND=turso",
        `CDK_PARAM_TURSO_DATABASE_URL=https://${DATABASE_HOST}`,
        "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    return root;
  }

  function rotateRunner(calls: RotateCall[]) {
    return (command: string, args: readonly string[], options: { input?: string } = {}) => {
      calls.push({ command, args, input: options.input });
      const joined = `${command} ${args.join(" ")}`;
      if (joined === "turso --version" || joined === "turso auth whoami") return SUCCESS;
      if (joined === "turso db list") {
        return {
          ...SUCCESS,
          stdout: [
            "NAME               TYPE      GROUP      URL",
            `tenkacloud-lite    SQLite    default    libsql://${DATABASE_HOST}`,
            "",
          ].join("\n"),
        };
      }
      if (args[2] === "create") return { ...SUCCESS, stdout: `${ISSUED_TOKEN}\n` };
      if (args[1] === "put-parameter") {
        return { ...SUCCESS, stdout: JSON.stringify({ Version: 12 }) };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };
  }

  function rotateDeps(root: string, over: Record<string, unknown> = {}) {
    return {
      repoRoot: root,
      interactive: true,
      platform: "darwin" as const,
      architecture: "arm64" as const,
      homeDirectory: "/home/test",
      installTursoCli: vi.fn(() => "/home/test/.turso/turso"),
      confirm: vi.fn(async () => true),
      prompt: vi.fn(async () => ""),
      log: vi.fn(),
      ...over,
    };
  }

  it("should reissue into SSM over stdin and verify the token without printing it", async () => {
    const root = rotateRoot();
    const calls: RotateCall[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [{ type: "ok" }, { type: "ok" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["rotate-token"],
        { ENV: "development" },
        rotateDeps(root, { processRunner: { run: rotateRunner(calls) }, log }),
      ),
    ).resolves.toBe(0);

    expect(calls.find(({ args }) => args[2] === "create")?.args).toEqual([
      "db",
      "tokens",
      "create",
      "tenkacloud-lite",
      "--expiration",
      "never",
    ]);
    const put = calls.find(({ args }) => args[1] === "put-parameter");
    expect(put?.args).toEqual(expect.arrayContaining(["--overwrite", "file:///dev/stdin"]));
    expect(put?.input).toBe(ISSUED_TOKEN);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://${DATABASE_HOST}/v2/pipeline`,
      expect.objectContaining({ method: "POST" }),
    );
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Version 12");
    expect(output).toContain("2099-06-07");
    expect(output).not.toContain(ISSUED_TOKEN);
    expect(
      calls.map(({ command, args }) => `${command} ${args.join(" ")}`).join("\n"),
    ).not.toContain(ISSUED_TOKEN);
  });

  it("should pass --expiration and --database through to the Turso CLI", async () => {
    const root = rotateRoot();
    const calls: RotateCall[] = [];
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["rotate-token", "--expiration", "30d", "--database", "tenkacloud-lite-staging"],
        { ENV: "development" },
        rotateDeps(root, {
          processRunner: { run: rotateRunner(calls) },
          confirm: vi.fn(async () => false),
          log,
        }),
      ),
    ).resolves.toBe(1);

    // confirm 拒否なので token は作らない。 flag は plan 表示から確認する。
    expect(calls.find(({ args }) => args[2] === "create")).toBeUndefined();
    expect(calls.find(({ args }) => args[1] === "list")).toBeUndefined();
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("expiration:      30d");
    expect(output).toContain("tenkacloud-lite-staging");
  });

  it("should reject a flag whose value is missing instead of consuming the next flag", async () => {
    const root = rotateRoot();
    const run = vi.fn(() => SUCCESS);
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["rotate-token", "--expiration", "--yes"],
        { ENV: "development" },
        rotateDeps(root, { processRunner: { run }, log }),
      ),
    ).resolves.toBe(1);

    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("--expiration には値が必要です");
  });

  it("should stop with an install hint when the Turso CLI is missing", async () => {
    const root = rotateRoot();
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["rotate-token"],
        { ENV: "development" },
        rotateDeps(root, {
          processRunner: { run: vi.fn(() => ({ status: 1, stdout: "", stderr: "not found" })) },
          log,
        }),
      ),
    ).resolves.toBe(1);

    expect(log.mock.calls.flat().join("\n")).toContain("make turso-live");
  });

  it("should refuse in a non-interactive session when Turso is not logged in", async () => {
    const root = rotateRoot();
    const run = vi.fn((command: string, args: readonly string[]) =>
      `${command} ${args.join(" ")}` === "turso --version"
        ? SUCCESS
        : { status: 1, stdout: "", stderr: "not logged in" },
    );
    const log = vi.fn();

    await expect(
      runTursoLiveCommand(
        ["rotate-token", "--yes"],
        { ENV: "development" },
        rotateDeps(root, { processRunner: { run }, interactive: false, log }),
      ),
    ).resolves.toBe(1);

    expect(log.mock.calls.flat().join("\n")).toContain("turso auth login");
  });
});
