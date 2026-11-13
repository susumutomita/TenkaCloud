import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Capability,
  type CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";

export const SIMULATOR_DEPLOY_ROLE = "TenkaCloud-SimulatorDeploy-Role";
const STACK_NAME = "tc-simulator-bootstrap";
const ACCOUNT = "000000000000";

/** Stack-name prefixes of the reviewed problems the Simulator deploy role may create. */
const SIMULATOR_STACK_PREFIXES = ["tc-hello-world-", "tc-lambda-settings-viewer-"] as const;
/** Of those, the problems whose stacks contain a Lambda function and its execution role. */
const SIMULATOR_LAMBDA_PREFIXES = ["tc-lambda-settings-viewer-"] as const;

function deployRole(
  operatorAccountId: string,
  externalId: string,
  policyName: string,
  statements: readonly Record<string, unknown>[],
): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      CompetitorDeployRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: SIMULATOR_DEPLOY_ROLE,
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${operatorAccountId}:root` },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": externalId } },
              },
            ],
          },
          Policies: [
            {
              PolicyName: policyName,
              PolicyDocument: { Version: "2012-10-17", Statement: statements },
            },
          ],
        },
      },
    },
    Outputs: { RoleArn: { Value: { "Fn::GetAtt": ["CompetitorDeployRole", "Arn"] } } },
  });
}

const STACK_ACTIONS = [
  "cloudformation:CreateStack",
  "cloudformation:DescribeStacks",
  "cloudformation:DeleteStack",
  "cloudformation:DescribeStackEvents",
];
const ROLE_ACTIONS = [
  "iam:CreateRole",
  "iam:DeleteRole",
  "iam:PutRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:TagRole",
  "iam:GetRole",
];
const PARAMETER_ACTIONS = [
  "ssm:PutParameter",
  "ssm:GetParameter",
  "ssm:DeleteParameter",
  "ssm:AddTagsToResource",
];

/**
 * The first released template, kept byte-for-byte so an installation that still owns it can be
 * recognised and replaced. Do not change it.
 */
export function legacyHelloWorldBootstrapTemplate(
  operatorAccountId: string,
  externalId: string,
  region: string,
): string {
  return deployRole(operatorAccountId, externalId, "HelloWorldDeploy", [
    {
      Effect: "Allow",
      Action: STACK_ACTIONS,
      Resource: `arn:aws:cloudformation:${region}:${ACCOUNT}:stack/tc-hello-world-*/*`,
    },
    {
      Effect: "Allow",
      Action: ROLE_ACTIONS,
      Resource: `arn:aws:iam::${ACCOUNT}:role/tc-hello-world-*`,
    },
    {
      Effect: "Allow",
      Action: PARAMETER_ACTIONS,
      Resource: `arn:aws:ssm:${region}:${ACCOUNT}:parameter/tc-hello-world-*`,
    },
  ]);
}

/** Simulator-only bootstrap: preserve normal competitor bootstrap, without its AdministratorAccess. */
export function simulatorBootstrapTemplate(
  operatorAccountId: string,
  externalId: string,
  region: string,
): string {
  const each = (format: (prefix: string) => string, prefixes: readonly string[]) =>
    prefixes.map(format);
  return deployRole(operatorAccountId, externalId, "ReviewedProblemDeploy", [
    {
      Effect: "Allow",
      Action: STACK_ACTIONS,
      Resource: each(
        (prefix) => `arn:aws:cloudformation:${region}:${ACCOUNT}:stack/${prefix}*/*`,
        SIMULATOR_STACK_PREFIXES,
      ),
    },
    {
      Effect: "Allow",
      Action: ROLE_ACTIONS,
      Resource: each(
        (prefix) => `arn:aws:iam::${ACCOUNT}:role/${prefix}*`,
        SIMULATOR_STACK_PREFIXES,
      ),
    },
    {
      Effect: "Allow",
      Action: PARAMETER_ACTIONS,
      Resource: each(
        (prefix) => `arn:aws:ssm:${region}:${ACCOUNT}:parameter/${prefix}*`,
        SIMULATOR_STACK_PREFIXES,
      ),
    },
    {
      Effect: "Allow",
      Action: ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunctionConfiguration"],
      Resource: each(
        (prefix) => `arn:aws:lambda:${region}:${ACCOUNT}:function:${prefix}*`,
        SIMULATOR_LAMBDA_PREFIXES,
      ),
    },
    // CreateFunction hands the function its execution role; only that problem's own roles.
    {
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: each(
        (prefix) => `arn:aws:iam::${ACCOUNT}:role/${prefix}*`,
        SIMULATOR_LAMBDA_PREFIXES,
      ),
    },
  ]);
}

async function describe(client: Pick<CloudFormationClient, "send">): Promise<Stack | undefined> {
  try {
    return (await client.send(new DescribeStacksCommand({ StackName: STACK_NAME }))).Stacks?.[0];
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ValidationError" &&
      error.message.includes("does not exist")
    )
      return undefined;
    throw error;
  }
}

type BootstrapClient = Pick<CloudFormationClient, "send">;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function ownedBy(stack: Stack | undefined, ownership: string): stack is Stack {
  return (
    stack?.StackName === STACK_NAME &&
    Boolean(
      stack.Tags?.some(
        (tag) => tag.Key === "tenkacloud:simulator-bootstrap" && tag.Value === ownership,
      ),
    )
  );
}

/**
 * Retained Simulator state may hold the first template this installation created. Only that exact
 * owned, completed stack is deleted; the caller then creates the current one.
 */
async function deleteOwnedLegacyBootstrap(
  client: BootstrapClient,
  legacyOwnership: string,
): Promise<void> {
  await client.send(new DeleteStackCommand({ StackName: STACK_NAME }));
  for (let attempts = 0; attempts < 30; attempts++) {
    const stack = await describe(client);
    if (!stack || stack.StackStatus === "DELETE_COMPLETE") return;
    if (stack.StackStatus !== "DELETE_IN_PROGRESS" || !ownedBy(stack, legacyOwnership))
      throw new Error("legacy bootstrap did not delete");
    await sleep(1000);
  }
  throw new Error("legacy bootstrap deletion timed out");
}

async function awaitOwnedBootstrap(
  client: BootstrapClient,
  initial: Stack | undefined,
  ownership: string,
): Promise<void> {
  let stack = initial;
  for (let attempts = 0; attempts < 30; attempts++) {
    if (!ownedBy(stack, ownership)) throw new Error("ownership conflict");
    if (stack.StackStatus === "CREATE_COMPLETE") {
      if (
        !stack.Outputs?.some(
          (output) =>
            output.OutputKey === "RoleArn" &&
            output.OutputValue === `arn:aws:iam::${ACCOUNT}:role/${SIMULATOR_DEPLOY_ROLE}`,
        )
      )
        throw new Error("role mismatch");
      return;
    }
    if (stack.StackStatus !== "CREATE_IN_PROGRESS") throw new Error("bootstrap did not complete");
    await sleep(1000);
    stack = await describe(client);
  }
  throw new Error("bootstrap timed out");
}

export async function bootstrapSimulatorRole(
  client: BootstrapClient,
  settings: {
    readonly operatorAccountId: string;
    readonly externalId: string;
    readonly region: string;
  },
): Promise<void> {
  if (settings.operatorAccountId !== "999999999999")
    throw new Error("Simulator bootstrap requires the native simulator operator identity.");
  const { operatorAccountId, externalId, region } = settings;
  const template = simulatorBootstrapTemplate(operatorAccountId, externalId, region);
  const ownership = sha256(template);
  const legacyOwnership = sha256(
    legacyHelloWorldBootstrapTemplate(operatorAccountId, externalId, region),
  );
  try {
    let stack = await describe(client);
    if (ownedBy(stack, legacyOwnership) && stack.StackStatus === "CREATE_COMPLETE") {
      await deleteOwnedLegacyBootstrap(client, legacyOwnership);
      stack = undefined;
    }
    if (!stack) {
      await client.send(
        new CreateStackCommand({
          StackName: STACK_NAME,
          TemplateBody: template,
          Capabilities: [Capability.CAPABILITY_NAMED_IAM],
          Tags: [{ Key: "tenkacloud:simulator-bootstrap", Value: ownership }],
        }),
      );
      stack = await describe(client);
    }
    await awaitOwnedBootstrap(client, stack, ownership);
  } catch {
    throw new Error(
      "Simulator bootstrap failed or conflicts with existing resources. Only this installation's own earlier bootstrap is replaced; inspect the local simulator bootstrap stack and role.",
    );
  }
}
