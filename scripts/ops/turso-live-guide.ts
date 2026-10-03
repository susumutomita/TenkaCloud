#!/usr/bin/env bun
/** Existing Turso operational checks, using the same selectors and preflight as cloud deploy. */
import { cloudControlDataConfiguration } from "../../infrastructure/lib/cloud-hosting/config";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import type { ProcessRunner } from "../cli/process";
import { selectCloudInstallation } from "../cloud-hosting/installation-selection";
import { verifyTursoBeforeDeployment } from "../cloud-hosting/turso-preflight";
import { probeTursoConnection } from "../cloud-hosting/turso-schema";

export type CommandRunner = ProcessRunner["run"];
export interface CheckResult {
  readonly ok: boolean;
  readonly output: string;
}

export function validateTursoLiveEnvironment(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    if (cloudControlDataConfiguration(env).kind !== "turso")
      return ["CDK_PARAM_CONTROL_DATA_BACKEND=turso is required."];
    if (!env.AWS_REGION?.trim()) return ["AWS_REGION is required."];
    if (!/^\d{12}$/u.test(env.ACCOUNT_ID?.trim() ?? ""))
      return ["ACCOUNT_ID must be the 12-digit hosting AWS account ID."];
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function verifyTursoAwsIdentity(env: NodeJS.ProcessEnv, run: CommandRunner): void {
  const errors = validateTursoLiveEnvironment(env);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const identity = run("aws", [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
    "--region",
    env.AWS_REGION ?? "",
  ]);
  if (identity.status !== 0 || identity.stdout.trim() !== env.ACCOUNT_ID?.trim())
    throw new Error(
      "Current AWS credentials do not match ACCOUNT_ID or caller identity could not be read; no token or AWS resource was changed.",
    );
}

export async function runTursoLivePreflight(
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
  probe = (databaseUrl: string, authToken: string) =>
    probeTursoConnection({ url: databaseUrl, authToken }),
): Promise<CheckResult> {
  const lines: string[] = [];
  try {
    verifyTursoAwsIdentity(env, run);
    const configuration = cloudControlDataConfiguration(env);
    if (configuration.kind !== "turso") throw new Error("Turso configuration is required.");
    await verifyTursoBeforeDeployment({
      configuration,
      region: env.AWS_REGION ?? "",
      now: Date.now(),
      probe,
      run: async (args) => {
        const result = run("aws", args);
        return { ...result, code: result.status };
      },
      output: (line) => lines.push(line.trimEnd()),
    });
    return { ok: true, output: lines.join("\n") };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

export async function runCloudFormationVerification(
  environment: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
): Promise<CheckResult> {
  try {
    verifyTursoAwsIdentity(env, run);
    const region = env.AWS_REGION ?? "";
    const layout = await selectCloudInstallation({
      environment,
      account: env.ACCOUNT_ID ?? "",
      region,
      explicitLayout: env.TENKACLOUD_STACK_LAYOUT,
      run: async (args) => {
        const result = run("aws", args);
        return { ...result, code: result.status };
      },
    });
    const names = cloudStackNames(environment, layout);
    const lines: string[] = [];
    for (const name of [names.app, names.backend]) {
      const common = ["--stack-name", name, "--region", region];
      const status = run("aws", [
        "cloudformation",
        "describe-stacks",
        ...common,
        "--query",
        "Stacks[0].StackStatus",
        "--output",
        "text",
      ]);
      if (
        status.status !== 0 ||
        !["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(status.stdout.trim())
      )
        throw new Error(`Stack ${name} is missing, unreadable or not successfully deployed.`);
      const count = run("aws", [
        "cloudformation",
        "list-stack-resources",
        ...common,
        "--query",
        "length(StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table'])",
        "--output",
        "text",
      ]);
      if (count.status !== 0 || count.stdout.trim() !== "0")
        throw new Error(`Stack ${name}: zero DynamoDB tables could not be verified.`);
      lines.push(`${name}: ${status.stdout.trim()}, DynamoDB tables=0`);
    }
    return { ok: true, output: lines.join("\n") };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

export function renderTursoLiveGuide(environment: string): string {
  cloudStackNames(environment);
  return [
    "Turso / AWS setup and credential rotation",
    `1. Select the intended AWS profile, then run make env-init ENV=${environment}.`,
    "   The wizard creates infrastructure/environments/<ENV>/.env only if absent.",
    "   Enter TENKACLOUD_ADMIN_EMAIL, ACCOUNT_ID and AWS_REGION. No access keys belong in .env.",
    `2. Run make turso-live ENV=${environment} in an interactive terminal.`,
    "   It offers the checksum-verified official Turso CLI, login, database creation and SSM SecureString setup.",
    "   Review each target before confirming. The token travels over stdin, never argv, .env or terminal output.",
    "   The default database name remains tenkacloud-lite (or tenkacloud-lite-<ENV>) for compatibility.",
    "   Public settings: CDK_PARAM_CONTROL_DATA_BACKEND=turso, CDK_PARAM_TURSO_DATABASE_URL, CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME.",
    "   The wizard runs authenticated preflight, asks for the exact word deploy, then runs the current make deploy and verifies both selected cloud/Lite stacks have zero DynamoDB tables.",
    `3. Resume separately: make turso-live-preflight ENV=${environment}; make deploy ENV=${environment}; make turso-live-verify-cfn ENV=${environment}.`,
    `4. Renew credentials: make turso-token-rotate ENV=${environment} ROTATE_ARGS="--expiration 30d".`,
    "   It resolves the database by URL, confirms replacement, issues a token, stores it in the selected SSM SecureString and verifies SELECT 1.",
    "   Default expiration: never. --database <name> must match the selected URL. --invalidate revokes all prior database tokens and can briefly interrupt warm Lambda instances.",
    "   Automation requires --yes; use an existing authenticated Turso CLI or TURSO_API_TOKEN from your secret provider. Never paste tokens into commands or logs.",
    `5. Data only: make turso-reset ENV=${environment} CLOUD_ARGS="--plan"; stop writers and finish exercise Teardown before a confirmed reset.`,
    "   Complete competitions before changing their installation. Existing providers/URLs are not migrated automatically.",
    "   See infrastructure/README.md for AWS permissions, setup, invitation sign-in and cleanup.",
  ].join("\n");
}
