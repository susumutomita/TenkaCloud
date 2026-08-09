import { ApiError, MachineApiClient, pollUntilSettled } from "./api-client.js";
import { optionalOption, parseArgs, requireOption, requirePositional, UsageError } from "./args.js";
import { cacheKey, type FetchLike, resolveAccessToken, TokenRequestError } from "./auth.js";
import { ConfigError, configFromEnv, parseConfig, type TcloudConfig } from "./config.js";
import type { TokenStore } from "./token-store.js";

/**
 * Issue #2951: CLI の本体。process / 時計 / fetch / 設定入出力を全部 dependency で受け取るので、
 * このモジュールは実 AWS も実ファイルも触らずにテストできる。`cli.ts` が現実の実装を差し込む。
 */

export const USAGE = `tcloud — TenkaCloud machine API operator CLI

Usage:
  tcloud auth login --client-id <id> --client-secret <secret>
  tcloud auth logout
  tcloud auth status
  tcloud deploy <problemId> --account <awsAccountId> --region <region> --team <teamName>
                            [--wait-timeout <seconds>] [--poll-interval <seconds>] [--no-wait]
  tcloud deployments list
  tcloud deployments get <jobId>

Configuration (never contains a secret):
  TCLOUD_MACHINE_API_URL  tenant stack output MachineApiUrl
  TCLOUD_TOKEN_URL        Cognito <domain>/oauth2/token
  TCLOUD_CLIENT_ID        machine client id
  TCLOUD_SCOPES           space separated scopes, including tc-tenant-<tenantId>/bind
  TCLOUD_CLIENT_SECRET    client secret (CI only; never written to disk)

Exit codes:
  0 success   1 usage / configuration error   2 API or authentication error
  3 the deployment finished in a failed state   4 the wait timed out
`;

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_API = 2;
export const EXIT_DEPLOY_FAILED = 3;
export const EXIT_TIMEOUT = 4;

export interface RunDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store: TokenStore;
  readonly fetchImpl: FetchLike;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** 設定の読み書き。secret は通さない。 */
  readonly readConfig: () => unknown;
  readonly writeConfig: (config: TcloudConfig) => void;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 900;

function loadConfig(deps: RunDeps): TcloudConfig {
  // 環境変数が完全に揃っていればそれを優先する (= CI がファイルを持たなくても動く)。
  const fromEnv = configFromEnv(deps.env);
  if (fromEnv) return fromEnv;
  return parseConfig(deps.readConfig());
}

async function withClient<T>(
  deps: RunDeps,
  config: TcloudConfig,
  body: (client: MachineApiClient) => Promise<T>,
): Promise<T> {
  const { token, fromCache } = await resolveAccessToken({
    store: deps.store,
    clientId: config.clientId,
    clientSecret: deps.env.TCLOUD_CLIENT_SECRET,
    tokenUrl: config.tokenUrl,
    scopes: config.scopes,
    nowMs: deps.now(),
    fetchImpl: deps.fetchImpl,
  });
  if (!fromCache && !deps.store.persistent) {
    deps.stderr(
      `note: token cache is ${deps.store.description}; every invocation will request a token.`,
    );
  }
  return body(
    new MachineApiClient({
      baseUrl: config.machineApiUrl,
      accessToken: token.accessToken,
      fetchImpl: deps.fetchImpl,
    }),
  );
}

async function runAuthLogin(deps: RunDeps): Promise<number> {
  const args = parseArgs(deps.argv.slice(2));
  const clientId = requireOption(args, "client-id");
  const clientSecret = requireOption(args, "client-secret");
  const machineApiUrl = optionalOption(args, "machine-api-url") ?? deps.env.TCLOUD_MACHINE_API_URL;
  const tokenUrl = optionalOption(args, "token-url") ?? deps.env.TCLOUD_TOKEN_URL;
  const scopes = (optionalOption(args, "scopes") ?? deps.env.TCLOUD_SCOPES ?? "")
    .split(/\s+/)
    .filter(Boolean);

  const config = parseConfig({ machineApiUrl, tokenUrl, clientId, scopes });
  // 設定ファイルには client secret を書かない。書くのは「どこに繋ぐか」だけ。
  deps.writeConfig(config);

  const { token } = await resolveAccessToken({
    store: deps.store,
    clientId: config.clientId,
    clientSecret,
    tokenUrl: config.tokenUrl,
    scopes: config.scopes,
    nowMs: deps.now(),
    fetchImpl: deps.fetchImpl,
  });
  const minutes = Math.round((token.expiresAtMs - deps.now()) / 60000);
  deps.stdout(`logged in as ${config.clientId}`);
  deps.stdout(`token cached in ${deps.store.description} for about ${minutes} minute(s)`);
  if (!deps.store.persistent) {
    deps.stdout(
      "warning: no OS keychain was found, so the token is not cached between invocations. " +
        "The client secret is never written to disk either way.",
    );
  }
  return EXIT_OK;
}

function runAuthLogout(deps: RunDeps): number {
  const config = loadConfig(deps);
  deps.store.clear(cacheKey(config.clientId, config.scopes));
  deps.stdout("cached token cleared");
  return EXIT_OK;
}

function runAuthStatus(deps: RunDeps): number {
  const config = loadConfig(deps);
  const cached = deps.store.read(cacheKey(config.clientId, config.scopes), deps.now());
  deps.stdout(`client id : ${config.clientId}`);
  deps.stdout(`machine api: ${config.machineApiUrl}`);
  deps.stdout(`scopes    : ${config.scopes.join(" ")}`);
  deps.stdout(`token cache: ${deps.store.description}`);
  deps.stdout(
    cached
      ? `token     : valid for about ${Math.round((cached.expiresAtMs - deps.now()) / 60000)} minute(s)`
      : "token     : none cached (the next command will request one)",
  );
  return EXIT_OK;
}

async function runDeploy(deps: RunDeps): Promise<number> {
  const args = parseArgs(deps.argv.slice(1));
  const problemId = requirePositional(args, 0, "problemId");
  const body = {
    awsAccountId: requireOption(args, "account"),
    region: requireOption(args, "region"),
    teamName: requireOption(args, "team"),
  };
  const pollIntervalMs =
    Number(optionalOption(args, "poll-interval") ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  const timeoutMs =
    Number(optionalOption(args, "wait-timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000;
  const noWait = args.options["no-wait"] === true;

  const config = loadConfig(deps);
  return withClient(deps, config, async (client) => {
    const started = await client.deployProblem(problemId, body);
    deps.stdout(`jobId: ${started.jobId}`);
    if (noWait) return EXIT_OK;

    let lastReported = "";
    const outcome = await pollUntilSettled({
      client,
      jobId: started.jobId,
      intervalMs: pollIntervalMs,
      timeoutMs,
      now: deps.now,
      sleep: deps.sleep,
      onStatus: (status) => {
        if (status !== lastReported) {
          lastReported = status;
          deps.stdout(`status: ${status}`);
        }
      },
    });
    if (outcome.kind === "succeeded") {
      deps.stdout(`deployment ${started.jobId} completed`);
      return EXIT_OK;
    }
    if (outcome.kind === "failed") {
      deps.stderr(`deployment ${started.jobId} finished in ${outcome.status}`);
      return EXIT_DEPLOY_FAILED;
    }
    // timeout は成功でも失敗でもない。緑にして CI を騙さない。
    deps.stderr(
      `timed out waiting for ${started.jobId}; last observed status was ${outcome.status}. ` +
        "The deployment is still running — check again with `tcloud deployments get`.",
    );
    return EXIT_TIMEOUT;
  });
}

async function runDeployments(deps: RunDeps): Promise<number> {
  const args = parseArgs(deps.argv.slice(1));
  const sub = requirePositional(args, 0, "deployments subcommand (list|get)");
  const config = loadConfig(deps);
  return withClient(deps, config, async (client) => {
    if (sub === "list") {
      deps.stdout(JSON.stringify(await client.listDeployments(), null, 2));
      return EXIT_OK;
    }
    if (sub === "get") {
      const jobId = requirePositional(args, 1, "jobId");
      deps.stdout(JSON.stringify(await client.getDeployment(jobId), null, 2));
      return EXIT_OK;
    }
    throw new UsageError(`unknown deployments subcommand: ${sub}`);
  });
}

async function dispatch(deps: RunDeps): Promise<number> {
  const command = deps.argv[0];
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return EXIT_OK;
  }
  if (command === "auth") {
    const sub = deps.argv[1];
    if (sub === "login") return runAuthLogin(deps);
    if (sub === "logout") return runAuthLogout(deps);
    if (sub === "status") return runAuthStatus(deps);
    throw new UsageError(`unknown auth subcommand: ${String(sub)}`);
  }
  if (command === "deploy") return runDeploy(deps);
  if (command === "deployments") return runDeployments(deps);
  throw new UsageError(`unknown command: ${command}`);
}

/** 例外を exit code へ写す唯一の場所。分類ごとに違う code を返す (= CI が分岐できる)。 */
export async function run(deps: RunDeps): Promise<number> {
  try {
    return await dispatch(deps);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      deps.stderr(error.message);
      deps.stderr("");
      deps.stderr(USAGE);
      return EXIT_USAGE;
    }
    if (error instanceof ApiError || error instanceof TokenRequestError) {
      deps.stderr(error.message);
      return EXIT_API;
    }
    deps.stderr(error instanceof Error ? error.message : "unknown error");
    return EXIT_API;
  }
}
