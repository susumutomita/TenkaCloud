import { expect, test } from "bun:test";
import { CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  bootstrapSimulatorRole,
  SIMULATOR_DEPLOY_ROLE,
  simulatorBootstrapTemplate,
} from "../simulator-bootstrap";

const settings = {
  operatorAccountId: "999999999999",
  externalId: "private-installation-external-id-123456",
  region: "ap-northeast-1",
};

test("simulator bootstrap uses exact installation trust and limited Hello World resources, never AdministratorAccess", () => {
  const template = JSON.parse(
    simulatorBootstrapTemplate(settings.operatorAccountId, settings.externalId, settings.region),
  );
  const role = template.Resources.CompetitorDeployRole.Properties;
  expect(role.RoleName).toBe(SIMULATOR_DEPLOY_ROLE);
  expect(role.AssumeRolePolicyDocument.Statement[0]).toMatchObject({
    Principal: { AWS: "arn:aws:iam::999999999999:root" },
    Condition: { StringEquals: { "sts:ExternalId": settings.externalId } },
  });
  expect(role.ManagedPolicyArns).toBeUndefined();
  expect(JSON.stringify(role)).not.toContain("AdministratorAccess");
  for (const statement of role.Policies[0].PolicyDocument.Statement) {
    expect(statement.Resource).toContain("tc-hello-world-");
    expect(statement.Action.every((action: string) => !action.endsWith(":*"))).toBe(true);
  }
});

test("bootstrap creates once and only reuses an exact owned stack; conflicting resources are never overwritten", async () => {
  let stack: Record<string, unknown> | undefined;
  let creates = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof DescribeStacksCommand) return { Stacks: stack ? [stack] : [] };
      if (command instanceof CreateStackCommand) {
        creates++;
        stack = {
          StackName: command.input.StackName,
          StackStatus: "CREATE_COMPLETE",
          Tags: command.input.Tags,
          Outputs: [
            {
              OutputKey: "RoleArn",
              OutputValue: `arn:aws:iam::000000000000:role/${SIMULATOR_DEPLOY_ROLE}`,
            },
          ],
        };
        return {};
      }
      throw new Error("Unexpected write");
    },
  };
  await bootstrapSimulatorRole(client as never, settings);
  await bootstrapSimulatorRole(client as never, settings);
  expect(creates).toBe(1);
  await expect(
    bootstrapSimulatorRole(client as never, {
      ...settings,
      externalId: "different-installation-secret",
    }),
  ).rejects.toThrow("conflicts");
  expect(creates).toBe(1);
});

test("bootstrap refuses unexpected identity and hides native diagnostics on collision/failure", async () => {
  let calls = 0;
  const client = {
    async send() {
      calls++;
      throw new Error(settings.externalId);
    },
  };
  await expect(
    bootstrapSimulatorRole(client as never, { ...settings, operatorAccountId: "123456789012" }),
  ).rejects.toThrow("native simulator");
  expect(calls).toBe(0);
  let failure: unknown;
  try {
    await bootstrapSimulatorRole(client as never, settings);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("Simulator bootstrap failed");
  expect(String(failure)).not.toContain(settings.externalId);
});
