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
});
