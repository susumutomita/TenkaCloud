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

/** Explicit first-account operation; ordinary deployment never calls this IAM-writing path. */
export async function setupCloudToolkit(
  request: Pick<ProcessRequest, "cwd" | "env">,
  io: CloudCliIo,
  yes: boolean,
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
  }
  const notice = `Create or update only ${artifacts.toolkit.stackName} in account ${artifacts.input.account}, region ${artifacts.input.region}? This installs the source-reviewed project deployment policies, service roles and retained CDK asset bucket. Initial setup requires separate IAM permissions. Deployment operators administer this TenkaCloud project across environments in the account/region where S3 and PassRole cannot be isolated; environment names are not an IAM security boundary. Review with make deploy CLOUD_ARGS="--show-setup" first.`;
  const authority = artifacts.policies.limits.map((limit) => `- ${limit}`).join("\n");
  io.stdout(`Deployment authority to review:\n${authority}\n${notice}\n`);
  if (!yes && !(await io.confirm(`${notice} [y/N] `))) {
    throw new Error("Project setup cancelled; no IAM or hosting resources were changed.");
  }
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
    check(result, "Install reviewed project toolkit");
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
