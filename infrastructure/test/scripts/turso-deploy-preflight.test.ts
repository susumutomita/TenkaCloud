import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandResult,
  runTursoDeployPreflight,
  type TokenProbe,
  tursoBackendSelected,
  validateTursoDeployConfig,
} from "../../../scripts/ops/turso-deploy-preflight";

/**
 * `make deploy` の Turso ゲート。
 *
 * 動機は実運用の失敗そのもの: lite-pipeline から turso を選んで CodeBuild が **緑で終わり**、
 * 最初に DB を開く Lambda が cold start で落ちて、 運用者には Admin Console の
 * `internal_error` 500 としてだけ見えた。 `env-check-lite` は 2 変数が空でないかしか見ず、
 * 「parameter が無い / SecureString でない / token が期限切れ」 のどれも通過していた。
 *
 * ここでは AWS を呼ばずに fake runner で全分岐を固定する。
 */

const TOKEN_PARAM = "/TenkaCloud/development/turso/auth-token";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    CDK_PARAM_TURSO_DATABASE_URL: "libsql://example.turso.io",
    CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: TOKEN_PARAM,
    AWS_REGION: "ap-northeast-1",
    ...overrides,
  };
}

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ status: 255, stdout: "", stderr });

/** `exp` だけを持つ JWT 風の token (署名は検証されない)。 */
function tokenExpiringAt(epochSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: epochSeconds }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

/**
 * `select 1` の seam。 既定は成功で、 「token は読めるが Turso に拒否される」 分岐だけ
 * 明示的に失敗させる。 network へは出ない。
 */
function prober(result: { ok: boolean; detail?: string } = { ok: true }) {
  const seen: { databaseUrl: string; token: string }[] = [];
  const probe: TokenProbe = (databaseUrl, token) => {
    seen.push({ databaseUrl, token });
    return Promise.resolve(result);
  };
  return { probe, seen };
}

function runner(responses: { describe?: CommandResult; get?: CommandResult }) {
  const calls: string[][] = [];
  const run = (command: string, args: readonly string[]): CommandResult => {
    calls.push([command, ...args]);
    if (args.includes("describe-parameters")) return responses.describe ?? ok("SecureString");
    if (args.includes("get-parameter")) return responses.get ?? ok("opaque-non-jwt-token");
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("turso deploy preflight — backend gate", () => {
  it("should do nothing when the backend is dynamodb", async () => {
    const { run, calls } = runner({});
    const result = await runTursoDeployPreflight(
      { CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb" },
      run,
      prober().probe,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("should do nothing when no backend is selected at all", async () => {
    const { run, calls } = runner({});
    expect((await runTursoDeployPreflight({}, run, prober().probe)).ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(tursoBackendSelected({})).toBe(false);
  });
});

describe("turso deploy preflight — config validation", () => {
  it("should accept the libsql:// URL the pipeline parameter tells operators to use", async () => {
    // turso-live preflight は https:// しか受けないが、runtime の @libsql/client/http は
    // libsql: を受ける。deploy ゲートが実際に動く設定を拒否してはいけない。
    expect(validateTursoDeployConfig(baseEnv())).toEqual([]);
    expect(
      validateTursoDeployConfig(baseEnv({ CDK_PARAM_TURSO_DATABASE_URL: "https://e.turso.io" })),
    ).toEqual([]);
  });

  it("should reject a URL scheme the runtime client cannot use", async () => {
    const errors = validateTursoDeployConfig(
      baseEnv({ CDK_PARAM_TURSO_DATABASE_URL: "wss://example.turso.io" }),
    );
    expect(errors.join()).toContain("libsql:// か https://");
  });

  it("should reject a parameter name that is not an absolute SSM path", async () => {
    const errors = validateTursoDeployConfig(
      baseEnv({ CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "TenkaCloud/turso/auth-token" }),
    );
    expect(errors.join()).toContain("/ で始まる絶対パス");
  });

  it("should require a region to resolve the parameter against", async () => {
    const errors = validateTursoDeployConfig(
      baseEnv({ AWS_REGION: "", AWS_DEFAULT_REGION: undefined }),
    );
    expect(errors.join()).toContain("AWS_REGION");
  });

  it("should fail the run before calling AWS when the config is invalid", async () => {
    const { run, calls } = runner({});
    const result = await runTursoDeployPreflight(
      baseEnv({ CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "no-leading-slash" }),
      run,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("turso deploy preflight — SSM parameter", () => {
  it("should fail when the parameter does not exist in the deploy region", async () => {
    const { run } = runner({ describe: ok("None") });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("存在しません");
    expect(result.output).toContain("put-parameter");
  });

  it("should fail when the parameter is a plain String rather than SecureString", async () => {
    const { run } = runner({ describe: ok("String") });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("SecureString が必要");
  });

  it("should fail when describe-parameters itself is denied", async () => {
    const { run } = runner({ describe: fail("AccessDeniedException") });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("AccessDeniedException");
  });
});

/**
 * 実運用で起きた形: token は SSM にあり `exp` も切れていないのに、rotate がうまく通って
 * おらず Turso 側が受け付けない。metadata だけの検査は全部通過し、CodeBuild は緑で終わる。
 */
describe("turso deploy preflight — stored token actually works", () => {
  it("should fail when the stored token is rejected by the database", async () => {
    const later = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    const { run } = runner({ get: ok(tokenExpiringAt(later)) });
    const result = await runTursoDeployPreflight(
      baseEnv(),
      run,
      prober({ ok: false, detail: "HTTP 401" }).probe,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("接続できません");
    expect(result.output).toContain("HTTP 401");
    // 期限が有効なことは表示されたうえで落ちる。「exp は通ったのに使えない」が読み取れる形。
    expect(result.output).toContain("まで有効");
    expect(result.output).toContain("turso-token-rotate");
    expect(result.output).toContain("500");
  });

  it("should probe the configured database with the stored token", async () => {
    const { run } = runner({ get: ok("opaque-token") });
    const { probe, seen } = prober();
    const result = await runTursoDeployPreflight(baseEnv(), run, probe);
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ databaseUrl: "libsql://example.turso.io", token: "opaque-token" }]);
    // token は検査に使うだけで、出力には出さない。
    expect(result.output).not.toContain("opaque-token");
    expect(result.output).toContain("select 1 が成功");
  });

  it("should redact the token if the failure detail echoes it back", async () => {
    const { run } = runner({ get: ok("secret-token") });
    const result = await runTursoDeployPreflight(
      baseEnv(),
      run,
      prober({ ok: false, detail: "rejected token secret-token" }).probe,
    );
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("secret-token");
    expect(result.output).toContain("***");
  });

  it("should not probe at all on the dynamodb backend", async () => {
    const { run } = runner({});
    const { probe, seen } = prober();
    await runTursoDeployPreflight({ CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb" }, run, probe);
    expect(seen).toHaveLength(0);
  });
});

describe("turso deploy preflight — token expiry", () => {
  it("should fail on an expired token, naming the 401/500 consequence", async () => {
    const { run } = runner({ get: ok(tokenExpiringAt(Math.floor(Date.now() / 1000) - 60)) });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("期限切れ");
    expect(result.output).toContain("500");
  });

  it("should pass but warn when the token expires within a week", async () => {
    const soon = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const { run } = runner({ get: ok(tokenExpiringAt(soon)) });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("7日以内");
  });

  it("should pass on a long-lived token", async () => {
    const later = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    const { run } = runner({ get: ok(tokenExpiringAt(later)) });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Turso preflight passed");
  });

  it("should pass on a non-JWT token without claiming an expiry it cannot read", async () => {
    const { run } = runner({ get: ok("opaque-token") });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("期限は未確認");
  });

  it("should never echo the decrypted token value into its output", async () => {
    const secret = "super-secret-turso-token-value";
    const { run } = runner({ get: ok(secret) });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.output).not.toContain(secret);
  });

  it("should fail when the token cannot be decrypted", async () => {
    const { run } = runner({ get: fail("AccessDeniedException: kms:Decrypt") });
    const result = await runTursoDeployPreflight(baseEnv(), run, prober().probe);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("復号できません");
  });
});

/**
 * Makefile 側の配線を実物で固定する。 `make deploy` が本ゲートを prerequisite に持つこと、
 * `.env` の `CDK_PARAM_*` が recipe まで届くことの 2 点が要点で、 どちらも script の unit test
 * では検出できない (= pipeline が緑のまま 500 を作った経路そのもの)。
 *
 * AWS は呼ばない: dynamodb は即 no-op、 turso 側は config 不備で AWS 到達前に落とす。
 */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE_ENV = "test-turso-deploy-preflight-fixture";
const FIXTURE_DIR = join(REPO_ROOT, "infrastructure", "environments", FIXTURE_ENV);

const ENV_KEYS_UNDER_TEST = [
  "CDK_PARAM_CONTROL_DATA_BACKEND",
  "CDK_PARAM_TURSO_DATABASE_URL",
  "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

function runMakeTarget(envFileContent: string): { status: number | null; output: string } {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, ".env"), envFileContent, "utf8");
  // `make` の `-include $(ENV_FILE)` + bare `export` は、呼び出し側の shell に同名が
  // export されていると fixture を上書きする。 テストが別の理由で通る / 落ちるのを防ぐため、
  // 対象 key を除いた env を組み立てる (delete ではなく filter — no-dynamic-delete)。
  const sanitizedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !(ENV_KEYS_UNDER_TEST as readonly string[]).includes(key),
    ),
  );
  const result = spawnSync("make", ["turso-deploy-preflight", `ENV=${FIXTURE_ENV}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: sanitizedEnv,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("make deploy wiring", () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("should be a prerequisite of `make deploy`", async () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    expect(makefile).toMatch(/^deploy: env-check-lite turso-deploy-preflight build/m);
  });

  it("should stay silent and succeed for a dynamodb .env", async () => {
    const { status, output } = runMakeTarget(
      "TENANT_ADMIN_EMAIL=test@example.com\nCDK_PARAM_CONTROL_DATA_BACKEND=dynamodb\n",
    );
    expect(status).toBe(0);
    expect(output).not.toContain("Turso deploy preflight");
  });

  it("should read CDK_PARAM_* out of the .env and reject a bad Turso URL before deploying", async () => {
    const { status, output } = runMakeTarget(
      [
        "TENANT_ADMIN_EMAIL=test@example.com",
        "CDK_PARAM_CONTROL_DATA_BACKEND=turso",
        "CDK_PARAM_TURSO_DATABASE_URL=wss://example.turso.io",
        "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token",
        "AWS_REGION=ap-northeast-1",
        "",
      ].join("\n"),
    );
    expect(status).not.toBe(0);
    expect(output).toContain("libsql:// か https://");
  });
});
