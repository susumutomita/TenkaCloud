import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  renderTursoLiveGuide,
  runCloudFormationVerification,
  runTursoLivePreflight,
  validateTursoLiveEnvironment,
} from "../ops/turso-live-guide";
import { runTursoReset, tursoPipelinePost } from "../ops/turso-reset";
import { DEFAULT_TURSO_TOKEN_EXPIRATION, runTursoTokenRotate } from "../ops/turso-token-rotate";
import type { ProcessRunner } from "./process";
import { loadTursoLiveEnvironment } from "./turso-live-environment";
import { runTursoLiveSetup } from "./turso-live-setup";

export interface TursoLiveCommandDeps {
  readonly repoRoot: string;
  readonly processRunner: ProcessRunner;
  readonly interactive: boolean;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly homeDirectory: string;
  readonly installTursoCli: () => string;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly prompt: (question: string) => Promise<string>;
  readonly log: (message: string) => void;
}

export async function terminalPrompt(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

export async function terminalConfirm(question: string): Promise<boolean> {
  const answer = (await terminalPrompt(`${question} [y/N] `)).toLowerCase();
  return answer === "y" || answer === "yes";
}

function environmentName(env: NodeJS.ProcessEnv): string {
  return env.ENV ?? env.CDK_PARAM_ENVIRONMENT ?? "development";
}

function installedTursoCliPath(deps: TursoLiveCommandDeps): string {
  return join(deps.homeDirectory, ".turso", "turso");
}

function resolveTursoCli(deps: TursoLiveCommandDeps): string | undefined {
  if (deps.processRunner.run("turso", ["--version"]).status === 0) return "turso";
  const installed = installedTursoCliPath(deps);
  return deps.processRunner.run(installed, ["--version"]).status === 0 ? installed : undefined;
}

async function ensureTursoCli(deps: TursoLiveCommandDeps): Promise<string | undefined> {
  const available = resolveTursoCli(deps);
  if (available) return available;
  deps.log("Turso CLI が見つかりません。");
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    deps.log(`未対応OSです: ${deps.platform}`);
    return undefined;
  }
  if (
    !(await deps.confirm(
      `公式 Turso Cloud CLI (${deps.platform}/${deps.architecture}) をチェックサム検証してインストールしますか?`,
    ))
  ) {
    deps.log("Turso CLI のインストールを中止しました。");
    return undefined;
  }
  const installed = deps.installTursoCli();
  const verification = deps.processRunner.run(installed, ["--version"]);
  if (verification.status !== 0) throw new Error("Turso CLI installation could not be verified");
  deps.log(`✓ Turso CLI: ${installed}`);
  return installed;
}

async function ensureTursoAuthentication(
  tursoExecutable: string,
  deps: TursoLiveCommandDeps,
): Promise<boolean> {
  if (deps.processRunner.run(tursoExecutable, ["auth", "whoami"]).status === 0) return true;
  if (!deps.interactive) {
    deps.log("Turso にログインしていません。`turso auth login` を実行してから再実行してください。");
    return false;
  }
  if (!(await deps.confirm("Turso にログインしますか?"))) return false;
  const login = deps.processRunner.run(tursoExecutable, ["auth", "login"], { inherit: true });
  if (login.status !== 0) throw new Error("turso auth login failed");
  if (deps.processRunner.run(tursoExecutable, ["auth", "whoami"]).status !== 0) {
    throw new Error("Turso login completed but authentication could not be verified");
  }
  return true;
}

export async function runTursoLiveCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): Promise<number> {
  const command = args[0];
  const environment = environmentName(env);
  if (command === "guide") {
    deps.log(renderTursoLiveGuide(environment));
    return 0;
  }
  const loaded = loadTursoLiveEnvironment(deps.repoRoot, environment, env).env;
  const directResult = await runDirectTursoCommand(args, environment, loaded, deps);
  if (directResult !== undefined) return directResult;
  if (command) throw new Error(`Unknown turso-live command: ${command}`);

  if (!deps.interactive) {
    deps.log(
      "対話 wizard には TTY が必要です。設定確認だけなら `turso-live guide` を使ってください。",
    );
    if (env.CODEBUILD_BUILD_ID || env.CI) {
      deps.log(
        "CodeBuild/CI では Turso CLI をイメージに事前導入し、TURSO_API_TOKEN を secret 環境変数で渡してください。",
      );
    }
    return 1;
  }

  const tursoExecutable = await ensureTursoCli(deps);
  if (!tursoExecutable || !(await ensureTursoAuthentication(tursoExecutable, deps))) {
    deps.log(renderTursoLiveGuide(environment));
    return 1;
  }
  const setup = await runTursoLiveSetup(environment, loaded, { ...deps, tursoExecutable });
  if (!setup.ok) return 1;
  const preflight = runTursoLivePreflight(setup.env, (executable, executableArgs) =>
    deps.processRunner.run(executable === "turso" ? tursoExecutable : executable, executableArgs),
  );
  deps.log(preflight.output);
  if (!preflight.ok) return 1;
  const deploy = await deployTursoLive(environment, setup.env, deps);
  if (deploy !== 0) return deploy;
  const verification = runCloudFormationVerification(
    environment,
    setup.env,
    (executable, executableArgs) => deps.processRunner.run(executable, executableArgs),
  );
  deps.log(verification.output);
  if (!verification.ok) return 1;
  deps.log("✓ AWS deploy と DynamoDB 0-table 検証が完了しました。次は画面上の主要フローです。");
  deps.log(renderTursoLiveGuide(environment));
  return 0;
}

/**
 * サブコマンド dispatch。 引数なし (= 対話 wizard) のときだけ undefined を返し、
 * 呼び出し側の wizard 経路へ落とす。
 */
async function runDirectTursoCommand(
  args: readonly string[],
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): Promise<number | undefined> {
  const command = args[0];
  if (command === "deploy") return deployTursoLive(environment, env, deps);
  if (command === "reset") return resetTursoControlData(args, environment, env, deps);
  if (command === "rotate-token") return rotateTursoToken(args, environment, env, deps);
  return runReadOnlyTursoCommand(command, environment, env, deps);
}

/** destructive: 全 control-data 行の削除 (スキーマ / マイグレーション状態は維持)。 */
function resetTursoControlData(
  args: readonly string[],
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): Promise<number> {
  return runTursoReset({
    env,
    environment,
    processRunner: deps.processRunner,
    httpPost: tursoPipelinePost,
    confirm: deps.confirm,
    log: deps.log,
    interactive: deps.interactive,
    assumeYes: args.includes("--yes"),
  });
}

async function deployTursoLive(
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): Promise<number> {
  const errors = validateTursoLiveEnvironment(env);
  if (errors.length > 0) {
    deps.log(errors.map((error) => `✗ ${error}`).join("\n"));
    return 1;
  }
  if (!deps.interactive) {
    deps.log("Live deploy requires an interactive terminal and an exact `deploy` confirmation.");
    return 1;
  }
  deps.log(`AWS に共有リソースを作成します: environment=${environment}`);
  const confirmation = await deps.prompt("続行する場合だけ deploy と入力してください: ");
  if (confirmation !== "deploy") {
    deps.log("Deploy を中止しました。");
    return 1;
  }
  return deps.processRunner.run("make", ["deploy", `ENV=${environment}`], { inherit: true }).status;
}

/**
 * `--flag value` を読む。 値が無い / 次が別の flag なら `null` を返し、`--yes` のような
 * 後続 flag を expiration として飲み込ませない。
 */
function flagValue(args: readonly string[], flag: string): string | undefined | null {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

/**
 * `rotate-token`: Turso DB token を表示せずに再発行して SSM SecureString を上書きする。
 * 発行には turso CLI とログイン済みセッションが要るので、reset と違いここで解決する。
 */
async function rotateTursoToken(
  args: readonly string[],
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): Promise<number> {
  const expiration = flagValue(args, "--expiration");
  if (expiration === null) {
    deps.log("✗ --expiration には値が必要です (例: --expiration never / --expiration 30d)。");
    return 1;
  }
  const database = flagValue(args, "--database");
  if (database === null) {
    deps.log("✗ --database には database 名が必要です (例: --database tenkacloud-lite)。");
    return 1;
  }
  const tursoExecutable = resolveTursoCli(deps);
  if (!tursoExecutable) {
    deps.log("turso CLI が見つかりません。`make turso-live` で導入してください。");
    return 1;
  }
  if (!(await ensureTursoAuthentication(tursoExecutable, deps))) return 1;
  return runTursoTokenRotate({
    env,
    environment,
    processRunner: deps.processRunner,
    tursoExecutable,
    httpPost: tursoPipelinePost,
    confirm: deps.confirm,
    log: deps.log,
    interactive: deps.interactive,
    assumeYes: args.includes("--yes"),
    invalidate: args.includes("--invalidate"),
    expiration:
      expiration ?? (env.TURSO_TOKEN_EXPIRATION?.trim() || DEFAULT_TURSO_TOKEN_EXPIRATION),
    database: database ?? undefined,
  });
}

function runReadOnlyTursoCommand(
  command: string | undefined,
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): number | undefined {
  if (command === "preflight") {
    const tursoExecutable = resolveTursoCli(deps) ?? "turso";
    const result = runTursoLivePreflight(env, (executable, args) =>
      deps.processRunner.run(executable === "turso" ? tursoExecutable : executable, args),
    );
    deps.log(result.output);
    return result.ok ? 0 : 1;
  }
  if (command === "verify-cloudformation") {
    const result = runCloudFormationVerification(environment, env, (executable, args) =>
      deps.processRunner.run(executable, args),
    );
    deps.log(result.output);
    return result.ok ? 0 : 1;
  }
  return undefined;
}
