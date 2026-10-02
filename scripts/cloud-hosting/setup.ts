import { projectBootstrap } from "../../infrastructure/lib/cloud-hosting/bootstrap";
import {
  deploymentPolicies,
  projectBootstrapTemplate,
} from "../../infrastructure/lib/cloud-hosting/deployment-policy";
import { assertCommercialRegion } from "../../infrastructure/lib/cloud-hosting/regions";
import { parseRunnerBindings } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/execution-config";
import { assertOwnedBootstrap } from "./bootstrap-check";
import type { CloudCliIo, ProcessRequest, ProcessResult } from "./process";
import { isMissingStack } from "./stack-check";

export function setupArtifacts(env: NodeJS.ProcessEnv) {
  const account = env.ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const region = env.REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "";
  const environment = env.CDK_PARAM_ENVIRONMENT ?? env.ENV ?? "development";
  if (!/^\d{12}$/u.test(account))
    throw new Error("Set ACCOUNT_ID to inspect the account-specific setup template.");
  assertCommercialRegion(region);
  const input = {
    account,
    region,
    environment,
    ...(env.TENKACLOUD_RUNNER_BINDINGS
      ? { runnerBindings: parseRunnerBindings(env.TENKACLOUD_RUNNER_BINDINGS) }
      : {}),
  };
  return {
    toolkit: projectBootstrap(environment),
    template: projectBootstrapTemplate(input),
    policies: deploymentPolicies(input),
    input,
  };
}

async function confirmSetup(
  artifacts: ReturnType<typeof setupArtifacts>,
  io: CloudCliIo,
  options: { yes: boolean; mode: "setup-only" | "deploy"; create: boolean; ci: string | undefined },
): Promise<void> {
  const identities = artifacts.policies.identities;
  const roles = [
    identities.executionRoleArn,
    identities.deployRoleArn,
    identities.filePublishingRoleArn,
    identities.imagePublishingRoleArn,
    identities.lookupRoleArn,
  ];
  const policies = [
    ...identities.executionPolicyArns,
    identities.operatorPolicyArn,
    identities.applicationBoundaryArn,
  ];
  const continuation =
    options.mode === "deploy"
      ? " After setup, this command continues the application deployment with the same credentials."
      : " This command installs the toolkit only; it does not deploy the application.";
  const notice = `${options.create ? "Create" : "Update"} ${artifacts.toolkit.stackName} in account ${artifacts.input.account}, region ${artifacts.input.region}, environment ${artifacts.input.environment}? This installs the source-reviewed project deployment policies, service roles and retained CDK asset resources. Initial setup requires separate IAM permissions; it does not attach permissions to your current user or role.${continuation} Deployment operators administer this TenkaCloud project across environments in the account/region where S3 and PassRole cannot be isolated; environment names are not an IAM security boundary.`;
  const authority = artifacts.policies.limits.map((limit) => `- ${limit}`).join("\n");
  const roleList = roles.map((arn) => `- ${arn}`).join("\n");
  const policyList = policies.map((arn) => `- ${arn}`).join("\n");
  io.stdout(
    `Initial project setup:\n${notice}\nIAM roles:\n${roleList}\nManaged IAM policies:\n${policyList}\nRetained CDK asset bucket: ${identities.assetBucketName}\nOther toolkit resources: qualifier-scoped ECR container-assets repository and SSM bootstrap-version parameter.\nDeployment authority to review:\n${authority}\nInspect the full IAM documents and initial-caller permissions offline with make -s deploy ENV=${artifacts.input.environment} CLOUD_ARGS="--show-setup". AWS usage and retained asset storage can incur charges.\n`,
  );
  if (!options.yes && (options.ci || !(await io.confirm(`${notice} [y/N] `)))) {
    const args = options.mode === "deploy" ? "--setup-if-needed --yes" : "--setup --yes";
    throw new Error(
      `Project setup cancelled; no IAM or hosting resources were changed. For unattended setup, review --show-setup, then explicitly approve initial IAM setup with make deploy ENV=${artifacts.input.environment} CLOUD_ARGS="${args}" using an authorized profile. --yes alone on ordinary deploy does not approve initial IAM setup.`,
    );
  }
}

/** Initial IAM setup requires its own confirmation, including when reached from deploy. */
export async function setupCloudToolkit(
  request: Pick<ProcessRequest, "cwd" | "env">,
  io: CloudCliIo,
  yes: boolean,
  mode: "setup-only" | "deploy" = "setup-only",
): Promise<void> {
  const artifacts = setupArtifacts(request.env);
  const policyArn = artifacts.policies.identities.executionPolicyArns.join(",");
  const args = ["--stack-name", artifacts.toolkit.stackName, "--region", artifacts.input.region];
  const run = (commandArgs: readonly string[]) =>
    io.run({ ...request, command: "aws", args: commandArgs });
  const check = (result: ProcessResult, phase: string) => {
    if (result.code !== 0) throw new Error(`${phase} failed: ${result.stderr.trim()}`);
  };
  const existing = await run([
    "cloudformation",
    "describe-stacks",
    ...args,
    "--query",
    "Stacks[0]",
    "--output",
    "json",
  ]);
  const create =
    existing.code !== 0 && isMissingStack(existing.stderr, artifacts.toolkit.stackName);
  if (!create) {
    check(existing, "Inspect project toolkit");
    assertOwnedBootstrap(existing.stdout, artifacts.input.environment, policyArn);
    // Another caller may have completed first setup after deploy's missing-stack check.
    // A deploy never updates an installed toolkit or its IAM policies.
    if (mode === "deploy") return;
  }
  await confirmSetup(artifacts, io, { yes, mode, create, ci: request.env.CI });
  const result = await run([
    "cloudformation",
    create ? "create-stack" : "update-stack",
    ...args,
    "--template-body",
    JSON.stringify(artifacts.template),
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--tags",
    "Key=TenkaCloudProject,Value=cloud-hosting",
    `Key=Environment,Value=${artifacts.input.environment}`,
    ...(create ? ["--enable-termination-protection"] : []),
  ]);
  const unchanged =
    !create && result.code !== 0 && result.stderr.includes("No updates are to be performed");
  if (!unchanged) {
    check(
      result,
      "Install reviewed project toolkit; the current profile needs the initial permissions in --show-setup Metadata.TenkaCloudSetupPermissions (see infrastructure/BOOTSTRAP-IAM.md)",
    );
    check(
      await run([
        "cloudformation",
        "wait",
        create ? "stack-create-complete" : "stack-update-complete",
        ...args,
      ]),
      "Wait for project toolkit",
    );
  }
  const installed = await run([
    "cloudformation",
    "describe-stacks",
    ...args,
    "--query",
    "Stacks[0]",
    "--output",
    "json",
  ]);
  check(installed, "Verify project toolkit");
  assertOwnedBootstrap(installed.stdout, artifacts.input.environment, policyArn);
  io.stdout(
    `Project setup verified. Ordinary deployment uses ${artifacts.policies.identities.operatorPolicyArn}; attach it only to the intended deployment operator through your account's IAM administrator. Organizers sign in through Cognito and need no AWS policy.\n`,
  );
}
