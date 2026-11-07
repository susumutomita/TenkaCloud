import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Capability,
  type CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";

export const SIMULATOR_DEPLOY_ROLE = "TenkaCloud-SimulatorDeploy-Role";
const STACK_NAME = "tc-simulator-bootstrap";
const ACCOUNT = "000000000000";

/** Simulator-only bootstrap: preserve normal competitor bootstrap, without its AdministratorAccess. */
export function simulatorBootstrapTemplate(
  operatorAccountId: string,
  externalId: string,
  region: string,
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
              PolicyName: "HelloWorldDeploy",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "cloudformation:CreateStack",
                      "cloudformation:DescribeStacks",
                      "cloudformation:DeleteStack",
                      "cloudformation:DescribeStackEvents",
                    ],
                    Resource: `arn:aws:cloudformation:${region}:${ACCOUNT}:stack/tc-hello-world-*/*`,
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "iam:CreateRole",
                      "iam:DeleteRole",
                      "iam:PutRolePolicy",
                      "iam:DeleteRolePolicy",
                      "iam:AttachRolePolicy",
                      "iam:DetachRolePolicy",
                      "iam:TagRole",
                      "iam:GetRole",
                    ],
                    Resource: `arn:aws:iam::${ACCOUNT}:role/tc-hello-world-*`,
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "ssm:PutParameter",
                      "ssm:GetParameter",
                      "ssm:DeleteParameter",
                      "ssm:AddTagsToResource",
                    ],
                    Resource: `arn:aws:ssm:${region}:${ACCOUNT}:parameter/tc-hello-world-*`,
                  },
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: { RoleArn: { Value: { "Fn::GetAtt": ["CompetitorDeployRole", "Arn"] } } },
  });
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

export async function bootstrapSimulatorRole(
  client: Pick<CloudFormationClient, "send">,
  settings: {
    readonly operatorAccountId: string;
    readonly externalId: string;
    readonly region: string;
  },
): Promise<void> {
  if (settings.operatorAccountId !== "999999999999")
    throw new Error("Simulator bootstrap requires the native simulator operator identity.");
  const template = simulatorBootstrapTemplate(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  const ownership = createHash("sha256").update(template).digest("hex");
  try {
    let stack = await describe(client);
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
    for (let attempts = 0; attempts < 30; attempts++) {
      if (
        !stack ||
        stack.StackName !== STACK_NAME ||
        !stack.Tags?.some(
          (tag) => tag.Key === "tenkacloud:simulator-bootstrap" && tag.Value === ownership,
        )
      )
        throw new Error("ownership conflict");
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
  } catch {
    throw new Error(
      "Simulator bootstrap failed or conflicts with existing resources. Nothing is overwritten automatically; inspect the local simulator bootstrap stack and role.",
    );
  }
}
