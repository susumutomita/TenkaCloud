import { createInterface } from "node:readline/promises";
import {
  renderTursoLiveGuide,
  runCloudFormationVerification,
  runTursoLivePreflight,
  validateTursoLiveEnvironment,
} from "../ops/turso-live-guide";
import type { ProcessRunner } from "./process";
import { loadTursoLiveEnvironment } from "./turso-live-environment";
import { runTursoLiveSetup } from "./turso-live-setup";

export interface TursoLiveCommandDeps {
  readonly repoRoot: string;
  readonly processRunner: ProcessRunner;
  readonly interactive: boolean;
  readonly platform: NodeJS.Platform;
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

async function ensureTursoCli(deps: TursoLiveCommandDeps): Promise<boolean> {
  if (deps.processRunner.run("turso", ["--version"]).status === 0) return true;
  deps.log("Turso CLI が見つかりません。");
  if (!deps.interactive) {
    deps.log("macOS: brew install tursodatabase/tap/turso");
    return false;
  }
  if (deps.platform !== "darwin") {
    deps.log("インストール手順: https://docs.turso.tech/cli/installation");
    return false;
  }
  if (!(await deps.confirm("公式 Homebrew tap から Turso CLI をインストールしますか?"))) {
    deps.log("中止しました。手動実行: brew install tursodatabase/tap/turso");
    return false;
  }
  const install = deps.processRunner.run("brew", ["install", "tursodatabase/tap/turso"], {
    inherit: true,
  });
  if (install.status !== 0) throw new Error("Turso CLI installation failed");
  return true;
}

async function ensureTursoAuthentication(deps: TursoLiveCommandDeps): Promise<boolean> {
  if (deps.processRunner.run("turso", ["auth", "whoami"]).status === 0) return true;
  if (!(await deps.confirm("Turso にログインしますか?"))) return false;
  const login = deps.processRunner.run("turso", ["auth", "login"], { inherit: true });
  if (login.status !== 0) throw new Error("turso auth login failed");
  if (deps.processRunner.run("turso", ["auth", "whoami"]).status !== 0) {
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
  if (command === "deploy") return deployTursoLive(environment, loaded, deps);
  const directResult = runReadOnlyTursoCommand(command, environment, loaded, deps);
  if (directResult !== undefined) return directResult;
  if (command) throw new Error(`Unknown turso-live command: ${command}`);

  if (!deps.interactive) {
    deps.log(
      "対話 wizard には TTY が必要です。設定確認だけなら `turso-live guide` を使ってください。",
    );
    return 1;
  }

  const available = await ensureTursoCli(deps);
  if (!available || !(await ensureTursoAuthentication(deps))) {
    deps.log(renderTursoLiveGuide(environment));
    return 1;
  }
  const setup = await runTursoLiveSetup(environment, loaded, deps);
  if (!setup.ok) return 1;
  const preflight = runTursoLivePreflight(setup.env, (executable, executableArgs) =>
    deps.processRunner.run(executable, executableArgs),
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

function runReadOnlyTursoCommand(
  command: string | undefined,
  environment: string,
  env: NodeJS.ProcessEnv,
  deps: TursoLiveCommandDeps,
): number | undefined {
  if (command === "preflight") {
    const result = runTursoLivePreflight(env, (executable, args) =>
      deps.processRunner.run(executable, args),
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
