import { resolve } from "node:path";
import type { ProcessResult, ProcessRunner } from "./process";
import {
  loadTursoLiveEnvironment,
  mergeSamlSsoFeature,
  writeTursoLiveEnvironment,
} from "./turso-live-environment";

export interface TursoLiveSetupDeps {
  readonly repoRoot: string;
  readonly processRunner: ProcessRunner;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly prompt: (question: string) => Promise<string>;
  readonly log: (message: string) => void;
  readonly tursoExecutable: string;
}

export interface TursoLiveSetupResult {
  readonly ok: boolean;
  readonly env: NodeJS.ProcessEnv;
}

function resultDetail(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
}

function requiredResult(label: string, result: ProcessResult): ProcessResult {
  if (result.status !== 0) throw new Error(`${label} failed: ${resultDetail(result)}`);
  return result;
}

function requiredSecretResult(label: string, result: ProcessResult): ProcessResult {
  if (result.status !== 0) throw new Error(`${label} failed (command output redacted)`);
  return result;
}

async function ensureEnvironmentFile(
  environment: string,
  baseEnv: NodeJS.ProcessEnv,
  deps: TursoLiveSetupDeps,
): Promise<boolean> {
  const loaded = loadTursoLiveEnvironment(deps.repoRoot, environment, baseEnv);
  if (loaded.exists) return true;
  deps.log(`設定ファイルがありません: ${loaded.path}`);
  if (!(await deps.confirm("基本の Lite .env wizard を起動しますか?"))) return false;
  const result = deps.processRunner.run(
    process.execPath,
    ["run", resolve(deps.repoRoot, "scripts", "ops", "env-init.ts")],
    {
      cwd: deps.repoRoot,
      env: { ...baseEnv, ENV: environment },
      inherit: true,
    },
  );
  if (result.status !== 0) throw new Error("Lite .env wizard failed");
  return loadTursoLiveEnvironment(deps.repoRoot, environment, baseEnv).exists;
}

function activeAwsAccount(deps: TursoLiveSetupDeps): string {
  requiredResult("AWS CLI", deps.processRunner.run("aws", ["--version"]));
  const identity = requiredResult(
    "aws sts get-caller-identity",
    deps.processRunner.run("aws", [
      "sts",
      "get-caller-identity",
      "--query",
      "Account",
      "--output",
      "text",
      "--no-cli-pager",
    ]),
  );
  const account = identity.stdout.trim();
  if (!/^\d{12}$/.test(account)) throw new Error(`AWS returned an invalid account ID: ${account}`);
  return account;
}

async function selectedAwsRegion(
  loaded: NodeJS.ProcessEnv,
  deps: TursoLiveSetupDeps,
): Promise<string> {
  const configured = loaded.AWS_REGION?.trim();
  if (configured) return configured;
  const fromCli = deps.processRunner.run("aws", ["configure", "get", "region"]);
  const fallback =
    fromCli.status === 0 && fromCli.stdout.trim() ? fromCli.stdout.trim() : "ap-northeast-1";
  const answer = (await deps.prompt(`AWS region [${fallback}]: `)).trim() || fallback;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(answer)) throw new Error(`Invalid AWS region: ${answer}`);
  return answer;
}

async function acceptActiveAccount(
  configured: string | undefined,
  active: string,
  environment: string,
  deps: TursoLiveSetupDeps,
): Promise<boolean> {
  if (!configured || configured === active) return true;
  deps.log(`AWS account mismatch: .env=${configured}, active=${active}`);
  return deps.confirm(`active account ${active} を ${environment} の deploy 先に更新しますか?`);
}

function validDatabaseName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

async function ensureTursoDatabase(
  environment: string,
  deps: TursoLiveSetupDeps,
): Promise<{ readonly name: string; readonly url: string } | undefined> {
  const fallback =
    environment === "development" ? "tenkacloud-lite" : `tenkacloud-lite-${environment}`;
  const name = (await deps.prompt(`Turso database name [${fallback}]: `)).trim() || fallback;
  if (!validDatabaseName(name)) {
    throw new Error("Turso database name must use lowercase letters, numbers, and dashes (max 64)");
  }
  let show = deps.processRunner.run(deps.tursoExecutable, ["db", "show", name, "--http-url"]);
  if (show.status !== 0) {
    deps.log(`Turso database ${name} はまだ見つかりません。`);
    if (!(await deps.confirm(`${name} を作成しますか?`))) return undefined;
    requiredResult(
      `turso db create ${name}`,
      deps.processRunner.run(deps.tursoExecutable, ["db", "create", name, "--wait"]),
    );
    show = requiredResult(
      `turso db show ${name}`,
      deps.processRunner.run(deps.tursoExecutable, ["db", "show", name, "--http-url"]),
    );
  }
  const url = show.stdout.trim();
  if (!/^https:\/\/[^/]+/i.test(url)) throw new Error(`Turso returned an invalid HTTP URL: ${url}`);
  deps.log(`✓ Turso database: ${name} (${url})`);
  return { name, url };
}

function ssmParameterType(parameterName: string, region: string, deps: TursoLiveSetupDeps): string {
  const result = requiredResult(
    `SSM parameter metadata ${parameterName}`,
    deps.processRunner.run("aws", [
      "ssm",
      "describe-parameters",
      "--parameter-filters",
      `Key=Name,Option=Equals,Values=${parameterName}`,
      "--region",
      region,
      "--query",
      "Parameters[0].Type",
      "--output",
      "text",
      "--no-cli-pager",
    ]),
  );
  return result.stdout.trim();
}

async function ensureSecureString(
  databaseName: string,
  parameterName: string,
  region: string,
  deps: TursoLiveSetupDeps,
): Promise<boolean> {
  const parameterType = ssmParameterType(parameterName, region, deps);
  if (parameterType === "SecureString") {
    deps.log(`SSM SecureString は既に存在します: ${parameterName}`);
    return deps.confirm("既存の token をこの Turso database 用として再利用しますか?");
  }
  if (parameterType && parameterType !== "None") {
    throw new Error(`SSM parameter ${parameterName} is ${parameterType}; SecureString is required`);
  }
  if (!(await deps.confirm(`書き込み token を作成して ${parameterName} に保存しますか?`))) {
    return false;
  }
  const tokenResult = requiredSecretResult(
    "turso db tokens create",
    deps.processRunner.run(deps.tursoExecutable, [
      "db",
      "tokens",
      "create",
      databaseName,
      "--expiration",
      "30d",
    ]),
  );
  const token = tokenResult.stdout.trim();
  if (!token || /\s/.test(token)) throw new Error("Turso returned an invalid database token");
  requiredSecretResult(
    "aws ssm put-parameter",
    deps.processRunner.run(
      "aws",
      [
        "ssm",
        "put-parameter",
        "--name",
        parameterName,
        "--type",
        "SecureString",
        "--value",
        "file:///dev/stdin",
        "--description",
        `TenkaCloud ${databaseName} database token`,
        "--region",
        region,
        "--no-cli-pager",
      ],
      { input: token },
    ),
  );
  deps.log("✓ Turso token を SSM SecureString に保存しました (token は表示していません)");
  return true;
}

export async function runTursoLiveSetup(
  environment: string,
  baseEnv: NodeJS.ProcessEnv,
  deps: TursoLiveSetupDeps,
): Promise<TursoLiveSetupResult> {
  deps.log("=== Turso/AWS live setup ===");
  if (!(await ensureEnvironmentFile(environment, baseEnv, deps))) {
    return { ok: false, env: baseEnv };
  }
  const loaded = loadTursoLiveEnvironment(deps.repoRoot, environment, baseEnv).env;
  const account = activeAwsAccount(deps);
  if (!(await acceptActiveAccount(loaded.AWS_ACCOUNT_ID?.trim(), account, environment, deps))) {
    return { ok: false, env: loaded };
  }
  const region = await selectedAwsRegion(loaded, deps);
  deps.log(`✓ AWS deploy target: ${account} / ${region}`);
  const database = await ensureTursoDatabase(environment, deps);
  if (!database) return { ok: false, env: loaded };

  const parameterName =
    loaded.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() ||
    `/TenkaCloud/${environment}/turso/auth-token`;
  if (!(await ensureSecureString(database.name, parameterName, region, deps))) {
    return { ok: false, env: loaded };
  }
  const overrides = {
    AWS_ACCOUNT_ID: account,
    AWS_REGION: region,
    CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    CDK_PARAM_TURSO_DATABASE_URL: database.url,
    CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: parameterName,
    CDK_PARAM_FEATURES: mergeSamlSsoFeature(loaded.CDK_PARAM_FEATURES),
  } as const;
  if (!(await deps.confirm("公開設定を選択した .env に保存しますか?"))) {
    return { ok: false, env: loaded };
  }
  const path = writeTursoLiveEnvironment(deps.repoRoot, environment, overrides);
  deps.log(`✓ 公開設定を保存しました: ${path} (mode 0600)`);
  return { ok: true, env: { ...loaded, ...overrides, ENV: environment } };
}
