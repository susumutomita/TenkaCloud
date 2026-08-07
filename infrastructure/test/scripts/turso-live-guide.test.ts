import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  renderTursoLiveGuide,
  runCloudFormationVerification,
  runTursoLivePreflight,
  validateTursoLiveEnvironment,
} from "../../../scripts/ops/turso-live-guide";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    AWS_ACCOUNT_ID: "123456789012",
    AWS_REGION: "ap-northeast-1",
    CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    CDK_PARAM_TURSO_DATABASE_URL: "https://tenkacloud-live-example.turso.io",
    CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/development/turso/auth-token",
    CDK_PARAM_FEATURES: '{"samlSso":true}',
  };
}

describe("scripts/ops/turso-live-guide (#2617)", () => {
  it("should render one ordered path from setup through live evidence capture", () => {
    const guide = renderTursoLiveGuide("development");

    expect(guide).toContain("Turso 初回ライブ E2E 検証ガイド");
    expect(guide).not.toMatch(/(?:Issue\s*)?#\d+/);
    expect(guide).toContain("macOS/Linux");
    expect(guide).toContain("Homebrew不要");
    expect(guide).toContain("TURSO_API_TOKEN");
    expect(guide).toContain("ENV=development tenkacloud turso-live preflight");
    expect(guide).toContain("ENV=development tenkacloud turso-live deploy");
    expect(guide).toContain("ENV=development tenkacloud turso-live verify-cloudformation");
    expect(guide).toContain("Competitor Accounts");
    expect(guide).toContain("Identity providers");
    expect(guide).toContain("ProblemEndpoints");
    expect(guide).toContain("Disruptions");
    expect(guide).toContain("監査ログ");
    expect(guide).toContain("docs/running-costs.md");
    expect(guide).toContain("--value file:///dev/stdin");
    expect(guide).toContain("printf '%s' \"$TURSO_TOKEN\" | aws ssm put-parameter");
    expect(guide).not.toContain('--value "$TURSO_TOKEN"');
    expect(guide.indexOf("事前確認")).toBeLessThan(guide.indexOf("tenkacloud turso-live deploy"));
    expect(guide.indexOf("tenkacloud turso-live deploy")).toBeLessThan(
      guide.indexOf("8. Application Admin Console で主要フロー"),
    );
  });

  it("should render environment-specific stack names without guessing", () => {
    const guide = renderTursoLiveGuide("staging");

    expect(guide).toContain("tenkacloud-lite-staging");
    expect(guide).toContain("tenkacloud-lite-problem-deploy-staging");
    expect(guide).toContain("infrastructure/environments/staging/.env");
  });

  it("should reject a non-turso backend and missing SAML verification flag", () => {
    const env = validEnvironment();
    env.CDK_PARAM_CONTROL_DATA_BACKEND = "dynamodb";
    env.CDK_PARAM_FEATURES = '{"samlSso":false}';

    expect(validateTursoLiveEnvironment(env)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDK_PARAM_CONTROL_DATA_BACKEND=turso"),
        expect.stringContaining("samlSso"),
      ]),
    );
  });

  it("should require an HTTP Turso URL, absolute SSM path, region, and account", () => {
    const env = validEnvironment();
    env.CDK_PARAM_TURSO_DATABASE_URL = "libsql://example.turso.io";
    env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME = "relative/token";
    delete env.AWS_REGION;
    delete env.AWS_ACCOUNT_ID;

    expect(validateTursoLiveEnvironment(env)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--http-url"),
        expect.stringContaining("/ で始まる"),
        expect.stringContaining("AWS_REGION"),
        expect.stringContaining("AWS_ACCOUNT_ID"),
      ]),
    );
  });

  it("should preflight AWS identity and SecureString metadata without requesting or printing a token", () => {
    const env = validEnvironment();
    const runner = vi.fn<CommandRunner>((command, args) => {
      if (command === "aws" && args[0] === "--version") {
        return { status: 0, stdout: "aws-cli/2", stderr: "" };
      }
      if (command === "turso" && args[0] === "--version") {
        return { status: 0, stdout: "turso 1", stderr: "" };
      }
      if (args[0] === "sts") {
        return { status: 0, stdout: "123456789012\n", stderr: "" };
      }
      return { status: 0, stdout: "SecureString\n", stderr: "" };
    });

    const result = runTursoLivePreflight(env, runner);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("AWS account: 123456789012");
    expect(result.output).toContain("SSM parameter: SecureString");
    const ssmCall = runner.mock.calls.find(([, args]) => args[0] === "ssm");
    expect(ssmCall?.[1]).toContain("describe-parameters");
    expect(ssmCall?.[1]).toContain("Parameters[0].Type");
    expect(ssmCall?.[1]).not.toContain("get-parameter");
    expect(ssmCall?.[1]).not.toContain("--with-decryption");
    expect(result.output).not.toMatch(/eyJ[A-Za-z0-9_-]+/);
  });

  it("should fail preflight when the active AWS account differs from the deployment account", () => {
    const runner: CommandRunner = (_command, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "version", stderr: "" };
      if (args[0] === "sts") {
        return { status: 0, stdout: "999999999999\n", stderr: "" };
      }
      return { status: 0, stdout: "SecureString\n", stderr: "" };
    };

    const result = runTursoLivePreflight(validEnvironment(), runner);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("AWS_ACCOUNT_ID=123456789012");
    expect(result.output).toContain("active=999999999999");
  });

  it("should verify both deployed stacks are complete and contain zero DynamoDB tables", () => {
    const runner = vi.fn<CommandRunner>((_command, args) => {
      if (args[1] === "describe-stacks") {
        return { status: 0, stdout: "CREATE_COMPLETE\n", stderr: "" };
      }
      return { status: 0, stdout: "0\n", stderr: "" };
    });

    const result = runCloudFormationVerification("development", validEnvironment(), runner);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("DynamoDB tables: 0");
    expect(result.output).toContain("tenkacloud-lite");
    expect(result.output).toContain("tenkacloud-lite-problem-deploy");
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("should fail CloudFormation verification when any DynamoDB table remains", () => {
    const runner: CommandRunner = (_command, args) => {
      if (args[1] === "describe-stacks") {
        return { status: 0, stdout: "UPDATE_COMPLETE\n", stderr: "" };
      }
      const stackName = args[args.indexOf("--stack-name") + 1];
      return {
        status: 0,
        stdout: stackName === "tenkacloud-lite" ? "1\n" : "0\n",
        stderr: "",
      };
    };

    const result = runCloudFormationVerification("development", validEnvironment(), runner);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("DynamoDB tables: 1");
  });

  it("should reject a rolled-back stack even though its status ends in COMPLETE", () => {
    const runner: CommandRunner = (_command, args) =>
      args[1] === "describe-stacks"
        ? { status: 0, stdout: "ROLLBACK_COMPLETE\n", stderr: "" }
        : { status: 0, stdout: "0\n", stderr: "" };

    const result = runCloudFormationVerification("development", validEnvironment(), runner);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("status=ROLLBACK_COMPLETE");
  });

  it("should expose the guide from the existing README, Make, and env-check paths", () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const readmeJa = readFileSync(join(REPO_ROOT, "README.ja.md"), "utf8");
    const runningCosts = readFileSync(join(REPO_ROOT, "docs/running-costs.md"), "utf8");
    const envExample = readFileSync(
      join(REPO_ROOT, "infrastructure/environments/development/.env.example"),
      "utf8",
    );

    expect(makefile).toContain("turso-live-guide:");
    expect(makefile).toContain("turso-live:");
    expect(makefile).toContain("ENV=$(ENV) bun run tenkacloud turso-live");
    expect(makefile).toContain("turso-live-preflight:");
    expect(makefile).toContain("turso-live-verify-cfn:");
    expect(makefile).toContain("bun run tenkacloud turso-live guide");
    expect(readme).toContain("tenkacloud turso-live");
    expect(readmeJa).toContain("tenkacloud turso-live");
    expect(runningCosts).toContain("## First live E2E verification runbook");
    expect(readme).toContain("make turso-live ENV=development");
    expect(readmeJa).toContain("make turso-live ENV=development");
    expect(runningCosts).toContain("make turso-live ENV=development");
    expect(runningCosts).toContain("including Codespaces");
    expect(runningCosts).toContain("avoids Homebrew and external tap dependencies");
    expect(runningCosts.match(/--value file:\/\/\/dev\/stdin/g)).toHaveLength(2);
    expect(runningCosts).not.toContain('--value "$TURSO_TOKEN"');
    expect(runningCosts).not.toContain('--value "<token from step 1>"');
    expect(envExample).toContain("tenkacloud turso-live");
  });

  it("should link the data boundary and live caveat to documents that still exist", () => {
    const alwaysOn = readFileSync(join(REPO_ROOT, "docs/always-on/README.md"), "utf8");

    expect(alwaysOn).not.toContain("CLAUDE.md#data-isolation");
    expect(alwaysOn).toContain("adr-049-always-on-cloudflare-control-plane.html");
    expect(alwaysOn).toContain("running-costs.md#first-live-e2e-verification-runbook");
  });

  it("should default make help to English and provide an explicit Japanese view", () => {
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    const english = execFileSync("make", [], { cwd: REPO_ROOT, encoding: "utf8" });
    const explicitEnglish = execFileSync("make", ["help-en"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const japanese = execFileSync("make", ["help-ja"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(makefile).toContain("# ===== Problem catalog validation | 問題カタログ検証 =====");
    expect(makefile).toContain(
      "# ===== Problem Packs (author-side CLI) | 問題パック（作成者向けCLI） =====",
    );
    expect(english).toBe(explicitEnglish);
    expect(english).toContain("Language: English (Japanese: make help-ja)");
    expect(english).toContain("Setup / Build");
    expect(english).toMatch(/^\s+install\s+Install development dependencies safely/m);
    expect(english).toMatch(
      /^\s+turso-live\s+Start the interactive Turso\/AWS live verification wizard/m,
    );
    // Issue #2906: `local` is now the Docker-only participant path;
    // `local-dev` (new) is the developer Bun/Vite hot-reload path and is
    // deliberately visible in help too, unlike the other `local-*` internals.
    expect(english).toMatch(
      /^\s+local\s+Start the local drill API and portal via Docker \(participant path\)/m,
    );
    expect(english).toMatch(/^\s+local-down\s+Stop local play and clear all persisted progress/m);
    expect(english).toMatch(
      /^\s+local-dev\s+Start local play on the host with Bun\/Vite \(developer path, hot reload\)/m,
    );
    for (const hiddenLocalTarget of [
      "doctor",
      "local-onboard",
      "local-up",
      "local-portal",
      "local-status",
      "local-list",
      "local-evaluate",
      "local-reset",
      "local-snapshot-export",
      "local-snapshot-import",
      "local-disrupt",
      "local-smoke",
    ]) {
      expect(english).not.toMatch(new RegExp(`^\\s+${hiddenLocalTarget}\\s+`, "m"));
    }
    expect(english).not.toContain("開発依存関係を安全設定でインストール");
    expect(japanese).toContain("言語: 日本語（英語: make help-en）");
    expect(japanese).toContain("セットアップ / ビルド");
    expect(japanese).toMatch(/^\s+install\s+開発依存関係を安全設定でインストール/m);
    expect(japanese).toMatch(/^\s+turso-live\s+Turso\/AWSの初回live検証wizardを開始/m);
    expect(japanese).toMatch(/^\s+local\s+Docker でローカル問題演習を起動\(参加者向け\)/m);
    expect(japanese).toMatch(
      /^\s+local-dev\s+ホストで Bun\/Vite により起動\(開発者向け・ホットリロード\)/m,
    );
    expect(japanese).not.toContain("Install development dependencies safely");
    for (const help of [english, japanese]) {
      expect(help).not.toMatch(/(?:Issue\s*)?#\d+/);
      expect(help.match(/^\s+check-synth\s+/gm)).toHaveLength(1);
      expect(help.match(/^\s+synth-always-on-command\s+/gm)).toHaveLength(1);
      expect(help.match(/^\s+synth-always-on-runtime\s+/gm)).toHaveLength(1);
      expect(help).not.toMatch(/^\s+ensure-deps\s+/m);
      for (const line of help.split("\n").filter((line) => /^\s{2}\S/.test(line))) {
        expect(line).toMatch(/^\s{2}\S+\s{2,}\S/);
      }
    }
  });
});
