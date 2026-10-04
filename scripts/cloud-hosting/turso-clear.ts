import {
  tursoDatabaseUrl,
  tursoTokenParameterName,
} from "../../infrastructure/lib/cloud-hosting/config";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import type { CloudCliOptions } from "./cli";
import { loadCloudEnvironment } from "./environment";
import type { CloudCliIo } from "./process";
import {
  CLOUD_TURSO_COMPETITION_TABLES,
  LITE_TURSO_COMPETITION_TABLES,
} from "./turso-clear-tables";
import {
  type TursoResetSql,
  withDirectTursoControlData,
  withTursoControlData,
} from "./turso-reset";
import { clearTursoControlData, type TursoResetOptions } from "./turso-reset-command";

export type TursoClearTarget = {
  readonly databaseUrl: string;
  readonly environment: string;
} & (
  | { readonly credentials: "direct"; readonly authToken: string }
  | {
      readonly credentials: "ssm";
      readonly parameterName: string;
      readonly account: string;
      readonly region: string;
    }
);

export const TURSO_CLEAR_HELP = `Standalone make turso-clear ENV=development [CLOUD_ARGS="--plan|--yes"] clears competition data only. It uses the selected CDK_PARAM_TURSO_DATABASE_URL. By default, a nonblank process-only TURSO_AUTH_TOKEN selects direct access; otherwise it reads the configured SSM SecureString with matching ACCOUNT_ID and AWS_REGION. Tokens in .env are ignored. Direct access needs no AWS settings or commands. Explicit --credentials <direct|ssm> overrides this selection; a failed credential never triggers a retry with another source. SSM is used only to retrieve the existing Turso token: the selected AWS caller needs ssm:GetParameter on that exact account/region-qualified parameter ARN and kms:Decrypt authorization for its KMS key when a customer-managed key is used. No SSM write/list permissions are needed. Clear does not call STS, CloudFormation or bootstrap. Stop writers and finish exercise Teardown first; this does not remove AWS/Docker resources or reset configuration.\nLite competition tables (when present): ${LITE_TURSO_COMPETITION_TABLES.join(", ")}.\nPublished cloud-v1 competition tables (when present): ${CLOUD_TURSO_COMPETITION_TABLES.join(", ")}.\nAccount, authentication, connection, feature-flag, admin-audit and migration settings remain. make turso-reset and tenkacloud turso-live reset delete all known control-data rows, including account, IdP, connection, feature-flag and admin-audit data where present; schema, migration markers, unrelated tables and configuration files remain; the SSM parameter and Turso database itself are also preserved. Reset retrieves the existing token from SSM and checks the AWS account with STS GetCallerIdentity, which needs valid AWS credentials but no explicit IAM permission grant.\n`;

export function tursoClearCredentialSource(
  args: readonly string[],
  processToken: string | undefined,
): "direct" | "ssm" {
  let source: "direct" | "ssm" = processToken?.trim() ? "direct" : "ssm";
  let specified = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--yes", "-y", "--plan"].includes(argument ?? "")) continue;
    if (argument !== "--credentials" || specified)
      throw new Error(
        "Unknown or conflicting turso-clear argument. Use --plan, --yes or --credentials <direct|ssm>.",
      );
    const value = args[++index];
    if (value !== "direct" && value !== "ssm")
      throw new Error("Credential mode must be direct or ssm.");
    source = value;
    specified = true;
  }
  return source;
}

function ssmTarget(env: NodeJS.ProcessEnv): Extract<TursoClearTarget, { credentials: "ssm" }> {
  const databaseUrl = tursoDatabaseUrl(env.CDK_PARAM_TURSO_DATABASE_URL);
  const parameterName = tursoTokenParameterName(env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME);
  const accounts = [env.ACCOUNT_ID, env.CDK_DEFAULT_ACCOUNT]
    .filter((value) => value !== undefined)
    .map((value) => value.trim());
  if (
    !accounts.length ||
    accounts.some((value) => !/^\d{12}$/u.test(value)) ||
    new Set(accounts).size !== 1
  )
    throw new Error(
      "SSM credentials require one explicit 12-digit ACCOUNT_ID; CDK_DEFAULT_ACCOUNT must match if set.",
    );
  const regions = [env.REGION, env.AWS_REGION, env.AWS_DEFAULT_REGION, env.CDK_DEFAULT_REGION]
    .filter((value) => value !== undefined)
    .map((value) => value.trim());
  if (!regions.length || regions.some((value) => !value) || new Set(regions).size !== 1)
    throw new Error(
      "SSM credentials require an explicit AWS_REGION; configured region values must match.",
    );
  const region = regions[0] ?? "";
  assertCommercialRegion(region);
  const account = accounts[0] ?? "";
  return {
    credentials: "ssm",
    databaseUrl,
    environment: env.ENV ?? "development",
    account,
    region,
    parameterName: `arn:aws:ssm:${region}:${account}:parameter${parameterName}`,
  };
}

/** Select the credential source once; file tokens and credential failures never change it. */
export async function runTursoClear(
  args: readonly string[],
  io: CloudCliIo,
  options: CloudCliOptions,
  source: "direct" | "ssm",
): Promise<void> {
  // Capture before any environment configuration; a file token must never acquire process provenance.
  const authToken = options.env.TURSO_AUTH_TOKEN?.trim();
  const env = loadCloudEnvironment(options.root, options.env, {
    validateAwsCredentials: source === "ssm",
  });
  // Never export a file token to AWS credential providers or their subprocesses.
  delete env.TURSO_AUTH_TOKEN;
  const databaseUrl = tursoDatabaseUrl(env.CDK_PARAM_TURSO_DATABASE_URL);
  let target: TursoClearTarget;
  if (source === "ssm") {
    target = ssmTarget(env);
    io.configureEnvironment?.(env);
  } else {
    if (!authToken)
      throw new Error(
        "Direct turso-clear requires TURSO_AUTH_TOKEN supplied to this process by your secret provider. Tokens in .env files are ignored. To use the configured SSM SecureString, explicitly select --credentials ssm.",
      );
    target = { credentials: "direct", databaseUrl, environment: env.ENV, authToken };
  }
  if (!io.clearSelectedTursoData)
    throw new Error("Standalone Turso clear is unavailable; no rows were deleted.");
  await io.clearSelectedTursoData(target, {
    plan: args.includes("--plan"),
    yes: args.some((arg) => ["--yes", "-y"].includes(arg)),
    confirm: io.confirm,
    output: io.stdout,
  });
}

export async function clearSelectedTursoData(
  target: TursoClearTarget,
  options: TursoResetOptions,
): Promise<void> {
  options.output(
    `[cloud] Turso clear target: environment ${target.environment}\nDatabase: ${target.databaseUrl}\nCredentials: ${target.credentials === "direct" ? "process-only database token" : target.parameterName}\n`,
  );
  const action = (client: TursoResetSql) => clearTursoControlData(client, options, "competition");
  if (target.credentials === "direct") await withDirectTursoControlData(target, action);
  else await withTursoControlData(target, action);
}
