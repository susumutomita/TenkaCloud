import { describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "../../../scripts/cli/process";
import {
  DEFAULT_TURSO_TOKEN_EXPIRATION,
  describeTursoTokenExpiry,
  formatTursoTokenExpiryDate,
  parseTursoDatabaseList,
  runTursoTokenRotate,
  type TursoTokenRotateDeps,
} from "../../../scripts/ops/turso-token-rotate";

/**
 * `make turso-token-rotate` (#3051) の contract を pin する。
 *
 * このコマンドの価値は「token を一度も表示せずに再発行できること」なので、
 * 分岐の網羅と同じ重さで「log / argv / エラーメッセージのどこにも token が出ない」を
 * 全ケースで検査する。
 */

const MS_PER_SECOND = 1000;

/** base64url 固有文字 (`-` / `_`) を必ず含ませ、標準 base64 デコーダの取りこぼしを検出させる。 */
const URL_SAFE_FILLER = { pad: "~~~~~~~~", zz: "ÿÿÿÿÿ" } as const;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "EdDSA", typ: "JWT" }), encode(payload), "c2lnbmF0dXJl"].join(".");
}

function expiringJwt(isoDate: string): string {
  return jwt({ ...URL_SAFE_FILLER, exp: Math.floor(Date.parse(isoDate) / MS_PER_SECOND) });
}

/** exp を持たない Turso の無期限 token。 */
const NEVER_TOKEN = jwt({ ...URL_SAFE_FILLER, id: "tenkacloud-lite", a: "rw" });
const EXPIRING_TOKEN = expiringJwt("2099-03-04T05:06:07Z");

const DATABASE_HOST = "tenkacloud-lite-susumutomita.aws-us-west-2.turso.io";

/** .env は https、`turso db list` は libsql を返す = scheme 正規化を必ず通す。 */
const VALID_ENV: NodeJS.ProcessEnv = {
  CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
  CDK_PARAM_TURSO_DATABASE_URL: `https://${DATABASE_HOST}`,
  CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/development/turso/auth-token",
  AWS_REGION: "ap-northeast-1",
};

/** turso CLI v1.0.31 の実出力どおり、ヘッダ行と末尾の padding を含む整列テーブル。 */
const DB_LIST_STDOUT = [
  "NAME               TYPE      GROUP      URL                                                        ",
  "akigura            SQLite    default    libsql://akigura-susumutomita.aws-us-west-2.turso.io        ",
  `tenkacloud-lite    SQLite    default    libsql://${DATABASE_HOST}    `,
  "",
].join("\n");

const OK: ProcessResult = { status: 0, stdout: "", stderr: "" };

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

class RotateFixture {
  readonly calls: RunCall[] = [];
  dbList: ProcessResult = { ...OK, stdout: DB_LIST_STDOUT };
  invalidate: ProcessResult = OK;
  tokenCreate: ProcessResult = { ...OK, stdout: `${NEVER_TOKEN}\n` };
  putParameter: ProcessResult = { ...OK, stdout: JSON.stringify({ Version: 7, Tier: "Standard" }) };

  readonly runner: ProcessRunner = {
    run: (command, args, options = {}) => {
      this.calls.push({ command, args, input: options.input });
      if (command === "turso" && args[0] === "db" && args[1] === "list") return this.dbList;
      if (command === "turso" && args[1] === "tokens" && args[2] === "create") {
        return this.tokenCreate;
      }
      if (command === "turso" && args[1] === "tokens" && args[2] === "invalidate") {
        return this.invalidate;
      }
      if (command === "aws" && args[1] === "put-parameter") return this.putParameter;
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  ran(predicate: (call: RunCall) => boolean): RunCall | undefined {
    return this.calls.find(predicate);
  }

  argvText(): string {
    return this.calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n");
  }
}

type TestDeps = TursoTokenRotateDeps & { readonly logs: string[] };

function makeDeps(fixture: RotateFixture, over: Partial<TursoTokenRotateDeps> = {}): TestDeps {
  const logs: string[] = [];
  return {
    env: VALID_ENV,
    environment: "development",
    processRunner: fixture.runner,
    tursoExecutable: "turso",
    httpPost: vi.fn(async () => ({ results: [{ type: "ok" }, { type: "ok" }] })),
    confirm: vi.fn(async () => true),
    log: (message: string) => logs.push(message),
    interactive: true,
    assumeYes: false,
    invalidate: false,
    expiration: DEFAULT_TURSO_TOKEN_EXPIRATION,
    logs,
    ...over,
  };
}

/** token が「表示された」あらゆる経路を 1 か所で検査する。 */
function expectNoTokenLeak(deps: TestDeps, fixture: RotateFixture, token: string): void {
  expect(deps.logs.join("\n")).not.toContain(token);
  expect(fixture.argvText()).not.toContain(token);
}

describe("describeTursoTokenExpiry", () => {
  it("should read a Turso token without an exp claim as never expiring", () => {
    expect(describeTursoTokenExpiry(NEVER_TOKEN)).toEqual({ kind: "never" });
  });

  it("should decode a base64url payload and report the exp claim as a UTC date", () => {
    const token = expiringJwt("2027-01-01T00:00:00Z");
    // fixture 自体が base64url 固有文字を含むことを保証する (標準 base64 実装では壊れる)。
    expect(token.split(".")[1]).toMatch(/[-_]/);

    const expiry = describeTursoTokenExpiry(token);

    expect(expiry.kind).toBe("expires");
    if (expiry.kind === "expires") {
      expect(formatTursoTokenExpiryDate(expiry.at)).toBe("2027-01-01");
      expect(expiry.at.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    }
  });

  it("should report unknown for non-JWT, undecodable, and non-numeric exp values", () => {
    expect(describeTursoTokenExpiry("not-a-jwt")).toEqual({ kind: "unknown" });
    expect(describeTursoTokenExpiry("aaa.!!!not-base64!!!.ccc")).toEqual({ kind: "unknown" });
    expect(describeTursoTokenExpiry(jwt({ exp: "soon" }))).toEqual({ kind: "unknown" });
    expect(describeTursoTokenExpiry(jwt({ exp: Number.NaN }))).toEqual({ kind: "unknown" });
    const arrayPayload = `x.${Buffer.from("[1,2]").toString("base64url")}.y`;
    expect(describeTursoTokenExpiry(arrayPayload)).toEqual({ kind: "unknown" });
  });
});

describe("parseTursoDatabaseList", () => {
  it("should read name and URL from the aligned table and skip the header row", () => {
    expect(parseTursoDatabaseList(DB_LIST_STDOUT)).toEqual([
      { name: "akigura", url: "libsql://akigura-susumutomita.aws-us-west-2.turso.io" },
      { name: "tenkacloud-lite", url: `libsql://${DATABASE_HOST}` },
    ]);
  });

  it("should return nothing for output that has no URL column", () => {
    expect(parseTursoDatabaseList("no databases found\n")).toEqual([]);
  });
});

describe("runTursoTokenRotate", () => {
  it("should match the database by URL, store the token over stdin, and verify it", async () => {
    const fixture = new RotateFixture();
    const httpPost = vi.fn(async () => ({ results: [{ type: "ok" }, { type: "ok" }] }));
    const deps = makeDeps(fixture, { httpPost });

    expect(await runTursoTokenRotate(deps)).toBe(0);

    const create = fixture.ran((call) => call.args[2] === "create");
    expect(create?.args).toEqual([
      "db",
      "tokens",
      "create",
      "tenkacloud-lite",
      "--expiration",
      "never",
    ]);
    const put = fixture.ran((call) => call.args[1] === "put-parameter");
    expect(put?.args).toEqual(
      expect.arrayContaining([
        "--name",
        "/TenkaCloud/development/turso/auth-token",
        "--type",
        "SecureString",
        "--overwrite",
        "--value",
        "file:///dev/stdin",
        "--description",
        "TenkaCloud tenkacloud-lite database token",
        "--region",
        "ap-northeast-1",
      ]),
    );
    expect(put?.input).toBe(NEVER_TOKEN);
    expect(httpPost).toHaveBeenCalledWith(`https://${DATABASE_HOST}/v2/pipeline`, NEVER_TOKEN, {
      requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }],
    });
    expect(deps.logs.join("\n")).toContain("Version 7");
    expect(deps.logs.join("\n")).toContain("有効期限: 無期限");
    expect(deps.logs.join("\n")).toContain("再デプロイは不要");
    expectNoTokenLeak(deps, fixture, NEVER_TOKEN);
  });

  it("should report the decoded expiry date when a bounded expiration is requested", async () => {
    const fixture = new RotateFixture();
    fixture.tokenCreate = { ...OK, stdout: `${EXPIRING_TOKEN}\n` };
    const deps = makeDeps(fixture, { expiration: "30d" });

    expect(await runTursoTokenRotate(deps)).toBe(0);

    expect(fixture.ran((call) => call.args[2] === "create")?.args).toContain("30d");
    expect(deps.logs.join("\n")).toContain("有効期限: 2099-03-04 まで");
    expect(deps.logs.join("\n")).toContain("make turso-token-rotate ENV=development");
    expectNoTokenLeak(deps, fixture, EXPIRING_TOKEN);
  });

  it("should refuse before touching Turso when the backend is not turso", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, {
      env: { ...VALID_ENV, CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb" },
    });

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(fixture.calls).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain("turso ではありません");
  });

  it("should refuse a non-https database URL and a relative SSM parameter path", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, {
      env: {
        CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
        CDK_PARAM_TURSO_DATABASE_URL: `libsql://${DATABASE_HOST}`,
        CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "TenkaCloud/turso/auth-token",
      },
    });

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(fixture.calls).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain("TURSO_DATABASE_URL");
    expect(deps.logs.join("\n")).toContain("PARAMETER_NAME");
  });

  it("should fail loudly instead of guessing when no listed database matches the URL", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, {
      env: { ...VALID_ENV, CDK_PARAM_TURSO_DATABASE_URL: "https://other-org.turso.io" },
    });

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(fixture.ran((call) => call.args[2] === "create")).toBeUndefined();
    expect(deps.logs.join("\n")).toContain("該当 0 件");
    expect(deps.logs.join("\n")).toContain("--database <name>");
  });

  it("should fail loudly when two listed databases share the configured URL", async () => {
    const fixture = new RotateFixture();
    fixture.dbList = {
      ...OK,
      stdout: [
        "NAME       TYPE      GROUP      URL",
        `alpha      SQLite    default    libsql://${DATABASE_HOST}`,
        `beta       SQLite    default    https://${DATABASE_HOST}/`,
        "",
      ].join("\n"),
    };
    const deps = makeDeps(fixture);

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(deps.logs.join("\n")).toContain("該当 2 件");
    expect(fixture.ran((call) => call.args[2] === "create")).toBeUndefined();
  });

  it("should fail loudly when turso db list itself fails", async () => {
    const fixture = new RotateFixture();
    fixture.dbList = { status: 1, stdout: "", stderr: "not logged in" };
    const deps = makeDeps(fixture);

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(deps.logs.join("\n")).toContain("turso db list に失敗しました: not logged in");
  });

  it("should use --database without listing databases at all", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, { database: "tenkacloud-lite-staging" });

    expect(await runTursoTokenRotate(deps)).toBe(0);
    expect(fixture.ran((call) => call.args[1] === "list")).toBeUndefined();
    expect(fixture.ran((call) => call.args[2] === "create")?.args).toContain(
      "tenkacloud-lite-staging",
    );
  });

  it("should do nothing beyond listing when the operator declines the confirm", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, { confirm: vi.fn(async () => false) });

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(fixture.calls.map((call) => call.args[1])).toEqual(["list"]);
    expect(deps.logs.join("\n")).toContain("中止しました");
  });

  it("should require --yes in a non-interactive session", async () => {
    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, { interactive: false });

    expect(await runTursoTokenRotate(deps)).toBe(1);
    expect(fixture.ran((call) => call.args[1] === "put-parameter")).toBeUndefined();
    expect(deps.logs.join("\n")).toContain("非対話環境では --yes");

    const yesFixture = new RotateFixture();
    const yesDeps = makeDeps(yesFixture, { interactive: false, assumeYes: true });
    expect(await runTursoTokenRotate(yesDeps)).toBe(0);
    expect(yesDeps.confirm).not.toHaveBeenCalled();
    expect(yesFixture.ran((call) => call.args[1] === "put-parameter")).toBeDefined();
  });

  it("should invalidate existing tokens only when --invalidate is passed", async () => {
    const plain = new RotateFixture();
    expect(await runTursoTokenRotate(makeDeps(plain))).toBe(0);
    expect(plain.ran((call) => call.args[2] === "invalidate")).toBeUndefined();

    const fixture = new RotateFixture();
    const deps = makeDeps(fixture, { invalidate: true });
    expect(await runTursoTokenRotate(deps)).toBe(0);

    const invalidate = fixture.ran((call) => call.args[2] === "invalidate");
    expect(invalidate?.args).toEqual(["db", "tokens", "invalidate", "tenkacloud-lite", "--yes"]);
    // 失効は発行より先に走る (新 token を巻き込まないため)。
    expect(fixture.calls.findIndex((call) => call.args[2] === "invalidate")).toBeLessThan(
      fixture.calls.findIndex((call) => call.args[2] === "create"),
    );
    const question = vi.mocked(deps.confirm).mock.calls[0]?.[0] ?? "";
    expect(question).toContain("すべて失効");
    expectNoTokenLeak(deps, fixture, NEVER_TOKEN);
  });

  it("should stop before issuing a token when invalidation fails", async () => {
    const fixture = new RotateFixture();
    fixture.invalidate = { status: 1, stdout: "", stderr: "boom" };
    const deps = makeDeps(fixture, { invalidate: true });

    await expect(runTursoTokenRotate(deps)).rejects.toThrow("output redacted");
    expect(fixture.ran((call) => call.args[2] === "create")).toBeUndefined();
  });

  it("should pick the single JWT line when the CLI prints notices around the token", async () => {
    const fixture = new RotateFixture();
    fixture.tokenCreate = {
      ...OK,
      stdout: `You can disable automatic updates with turso config set autoupdate off\n${NEVER_TOKEN}\n`,
    };
    const deps = makeDeps(fixture);

    await expect(runTursoTokenRotate(deps)).resolves.toBe(0);
    expect(fixture.ran((call) => call.args[1] === "put-parameter")?.input).toBe(NEVER_TOKEN);
  });

  it.each([
    ["empty stdout", ""],
    ["whitespace inside the token", "header.pay load.signature"],
    ["a value that is not a three-part JWT", "not-a-jwt"],
    ["two JWT-shaped lines (ambiguous)", `${NEVER_TOKEN}\n${EXPIRING_TOKEN}`],
  ])("should reject %s without echoing the command output", async (_label, stdout) => {
    const fixture = new RotateFixture();
    fixture.tokenCreate = { ...OK, stdout: `${stdout}\n` };
    const deps = makeDeps(fixture);

    await expect(runTursoTokenRotate(deps)).rejects.toThrow("redacted");
    expect(fixture.ran((call) => call.args[1] === "put-parameter")).toBeUndefined();
  });

  it("should redact the partially generated secret when turso db tokens create fails", async () => {
    const fixture = new RotateFixture();
    fixture.tokenCreate = { status: 1, stdout: "partially-created-secret", stderr: "quota" };
    const deps = makeDeps(fixture);

    const rotate = runTursoTokenRotate(deps);
    await expect(rotate).rejects.toThrow("turso db tokens create failed (command output redacted)");
    await expect(rotate).rejects.not.toThrow("partially-created-secret");
    expect(deps.logs.join("\n")).not.toContain("partially-created-secret");
  });

  it("should redact the command output when the SSM write fails", async () => {
    const fixture = new RotateFixture();
    fixture.putParameter = { status: 1, stdout: NEVER_TOKEN, stderr: "AccessDenied" };
    const deps = makeDeps(fixture);

    await expect(runTursoTokenRotate(deps)).rejects.toThrow(
      "aws ssm put-parameter failed (command output redacted)",
    );
    expectNoTokenLeak(deps, fixture, NEVER_TOKEN);
  });

  it("should still succeed when put-parameter output carries no parsable Version", async () => {
    const fixture = new RotateFixture();
    fixture.putParameter = { ...OK, stdout: "7\n" };
    const deps = makeDeps(fixture);

    expect(await runTursoTokenRotate(deps)).toBe(0);
    expect(deps.logs.join("\n")).toContain("SSM SecureString に保存しました");
    expect(deps.logs.join("\n")).not.toContain("Version 7");
  });

  it("should exit non-zero without throwing when the new token is rejected with 401", async () => {
    const fixture = new RotateFixture();
    const httpPost = vi.fn(async () => {
      throw new Error(`Turso pipeline HTTP 401: invalid JWT token ${NEVER_TOKEN}`);
    });
    const deps = makeDeps(fixture, { httpPost });

    await expect(runTursoTokenRotate(deps)).resolves.toBe(1);
    expect(deps.logs.join("\n")).toContain("SSM は更新済みですが token が使えません");
    expect(deps.logs.join("\n")).toContain("invalid JWT token ***");
    expectNoTokenLeak(deps, fixture, NEVER_TOKEN);
  });

  it("should treat a 200 response carrying a pipeline error as a failed verification", async () => {
    const fixture = new RotateFixture();
    const httpPost = vi.fn(async () => ({
      results: [{ type: "error", error: { message: "no such table" } }],
    }));
    const deps = makeDeps(fixture, { httpPost });

    await expect(runTursoTokenRotate(deps)).resolves.toBe(1);
    expect(deps.logs.join("\n")).toContain("no such table");
    expect(deps.logs.join("\n")).not.toContain("select 1 が成功");
  });
});
