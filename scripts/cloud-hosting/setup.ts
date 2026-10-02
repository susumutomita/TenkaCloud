import { join } from "node:path";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import {
  assertStandardBootstrap,
  STANDARD_TOOLKIT_QUALIFIER,
  STANDARD_TOOLKIT_STACK,
} from "./bootstrap-check";
import type { CloudCliIo, ProcessRequest, ProcessResult } from "./process";
import { isMissingStack } from "./stack-check";

const STANDARD_BOOTSTRAP_ARGUMENTS = [
  "--toolkit-stack-name",
  STANDARD_TOOLKIT_STACK,
  "--qualifier",
  STANDARD_TOOLKIT_QUALIFIER,
  // An empty explicit profile ignores CDK settings and preserves the AWS environment chain.
  "--profile",
  "",
];

function setupTarget(env: NodeJS.ProcessEnv) {
  const account = env.ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const region = env.REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "";
  const environment = env.CDK_PARAM_ENVIRONMENT ?? env.ENV ?? "development";
  if (!/^\d{12}$/u.test(account))
    throw new Error("Set ACCOUNT_ID to inspect the account-specific standard CDK bootstrap.");
  assertCommercialRegion(region);
  return { account, region, environment, target: `aws://${account}/${region}` };
}

function bootstrapArguments(target: ReturnType<typeof setupTarget>): string[] {
  // The standard template derives its bucket name from this qualifier, account and region.
  return [
    ...STANDARD_BOOTSTRAP_ARGUMENTS,
    "--region",
    target.region,
    "--bootstrap-kms-key-id",
    "AWS_MANAGED_KEY",
  ];
}

function bootstrapNotice(target: ReturnType<typeof setupTarget>): string {
  const command = [
    "node_modules/aws-cdk/bin/cdk",
    "bootstrap",
    target.target,
    ...bootstrapArguments(target),
  ]
    .map((arg) => arg || "''")
    .join(" ");
  const suffix = `${target.account}-${target.region}`;
  const prefix = `arn:aws:iam::${target.account}:role/cdk-${STANDARD_TOOLKIT_QUALIFIER}`;
  const roles = ["cfn-exec", "deploy", "file-publishing", "image-publishing", "lookup"]
    .map((role) => `- ${prefix}-${role}-role-${suffix}`)
    .join("\n");
  return `Standard AWS CDK bootstrap for account ${target.account}, region ${target.region} (application environment ${target.environment}):\nCommand: ${command}\nToolkit: ${STANDARD_TOOLKIT_STACK}, default qualifier ${STANDARD_TOOLKIT_QUALIFIER}; shared across applications and environments in this account/region.\nIAM roles:\n${roles}\nThe standard CloudFormation execution role receives AWS-managed AdministratorAccess by default. This is broad account administration, not a TenkaCloud-scoped permission. The lookup role has ReadOnlyAccess with the standard template's restrictions; deployment and publishing roles can deploy CloudFormation stacks, pass the execution role, and publish assets. No permissions boundary or additional trusted account is requested. Your existing AWS profile must be authorized to create these resources; bootstrap does not attach permissions to your current user or role.\nOther resources: S3 asset bucket cdk-${STANDARD_TOOLKIT_QUALIFIER}-assets-${suffix}, ECR container-assets repository cdk-${STANDARD_TOOLKIT_QUALIFIER}-container-assets-${suffix}, and SSM parameter /cdk-bootstrap/${STANDARD_TOOLKIT_QUALIFIER}/version. AWS usage and retained asset storage can incur charges.\nExisting CDKToolkit policies, trust, boundaries and other customizations are preserved: this command reuses an installed toolkit without updating it. Inspect the official template with make -s deploy ENV=${target.environment} CLOUD_ARGS="--show-setup".\n`;
}

function check(result: ProcessResult, phase: string): void {
  if (result.code !== 0) throw new Error(`${phase} failed: ${result.stderr.trim()}`);
}

/** The official pinned CLI prints its own template without resolving AWS credentials. */
export async function showCloudToolkit(
  request: Pick<ProcessRequest, "cwd" | "env">,
  io: CloudCliIo,
): Promise<void> {
  const target = setupTarget(request.env);
  io.stdout(bootstrapNotice(target));
  const result = await io.run({
    ...request,
    command: join(request.cwd, "node_modules/aws-cdk/bin/cdk"),
    args: ["bootstrap", "--show-template", ...bootstrapArguments(target)],
  });
  check(result, "Inspect standard CDK bootstrap template");
  io.stdout(`${result.stdout}\n`);
}

/** Reuse CDKToolkit unchanged. Only a confirmed missing toolkit runs official bootstrap. */
export async function setupCloudToolkit(
  request: Pick<ProcessRequest, "cwd" | "env">,
  io: CloudCliIo,
  yes: boolean,
  mode: "setup-only" | "deploy" = "setup-only",
): Promise<void> {
  const target = setupTarget(request.env);
  const inspect = () =>
    io.run({
      ...request,
      command: "aws",
      args: [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        STANDARD_TOOLKIT_STACK,
        "--region",
        target.region,
        "--query",
        "Stacks[0]",
        "--output",
        "json",
      ],
    });
  const exists = (result: ProcessResult): boolean => {
    if (result.code !== 0 && isMissingStack(result.stderr, STANDARD_TOOLKIT_STACK)) return false;
    check(result, "Inspect standard CDKToolkit");
    assertStandardBootstrap(result.stdout, target.account, target.region);
    io.stdout("[cloud] Reusing existing CDKToolkit without changing its configuration.\n");
    return true;
  };
  if (exists(await inspect())) return;
  io.stdout(`[cloud] CDKToolkit is missing.\n${bootstrapNotice(target)}`);
  const continuation =
    mode === "deploy"
      ? " This command then continues the application deployment with the same credentials."
      : " This command installs the toolkit only; it does not deploy the application.";
  const question = `Create standard CDKToolkit in account ${target.account}, region ${target.region}, including its default AdministratorAccess execution role?${continuation}`;
  if (yes)
    io.stdout(
      `[cloud] Creating standard CDKToolkit in account ${target.account}, region ${target.region}.${continuation}\n`,
    );
  else if (request.env.CI) io.stdout(`${question}\n`);
  if (!yes && (request.env.CI || !(await io.confirm(`${question} [y/N] `)))) {
    const args = mode === "deploy" ? "--setup-if-needed --yes" : "--setup --yes";
    throw new Error(
      `Standard CDK bootstrap cancelled; no IAM or hosting resources were changed. Review --show-setup, then explicitly approve first bootstrap with make deploy ENV=${target.environment} CLOUD_ARGS="${args}" using an authorized profile.`,
    );
  }
  // Another caller may bootstrap after inspection. Reuse that toolkit rather than update it.
  if (exists(await inspect())) return;
  const result = await io.run({
    ...request,
    command: join(request.cwd, "node_modules/aws-cdk/bin/cdk"),
    args: ["bootstrap", target.target, ...bootstrapArguments(target)],
    inherit: true,
  });
  check(
    result,
    "Standard CDK bootstrap; use an AWS profile authorized for the displayed IAM and asset resources",
  );
  const installed = await inspect();
  check(installed, "Verify standard CDKToolkit");
  assertStandardBootstrap(installed.stdout, target.account, target.region);
  io.stdout("[cloud] Standard CDKToolkit verified.\n");
}
