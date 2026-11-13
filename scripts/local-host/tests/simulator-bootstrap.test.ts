import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  bootstrapSimulatorRole,
  legacyHelloWorldBootstrapTemplate,
  SIMULATOR_DEPLOY_ROLE,
  simulatorBootstrapTemplate,
} from "../simulator-bootstrap";

const settings = {
  operatorAccountId: "999999999999",
  externalId: "private-installation-external-id-123456",
  region: "ap-northeast-1",
};

test("simulator bootstrap uses exact installation trust and limited reviewed-problem resources, never AdministratorAccess", () => {
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
  const reviewed =
    /^arn:aws:[a-z]+:(ap-northeast-1)?:000000000000:(stack|role|parameter|function)[/:](tc-hello-world-|tc-lambda-settings-viewer-)\*(\/\*)?$/u;
  for (const statement of role.Policies[0].PolicyDocument.Statement) {
    const resources: string[] = [statement.Resource].flat();
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) expect(resource).toMatch(reviewed);
    expect(statement.Action.every((action: string) => !action.endsWith(":*"))).toBe(true);
    // Lambda functions, and handing them a role, are limited to the Lambda problem's own names.
    if (
      statement.Action.some(
        (action: string) => action.startsWith("lambda:") || action === "iam:PassRole",
      )
    )
      expect(
        resources.every(
          (resource) =>
            resource.includes(":tc-lambda-settings-viewer-*") ||
            resource.includes("/tc-lambda-settings-viewer-*"),
        ),
      ).toBe(true);
  }
  const actions = role.Policies[0].PolicyDocument.Statement.flatMap(
    (statement: { Action: string[] }) => statement.Action,
  );
  expect(actions).toContain("lambda:CreateFunction");
  expect(actions).toContain("iam:PassRole");
  expect(actions).not.toContain("lambda:InvokeFunction");
  expect(actions).not.toContain("lambda:UpdateFunctionCode");
});

test("the released Hello World bootstrap template stays byte-identical so retained installs are recognised", () => {
  const legacy = legacyHelloWorldBootstrapTemplate(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  expect(createHash("sha256").update(legacy).digest("hex")).toBe(
    "fab54d4d13651d045bb17c39cd922eec51a1508b2e903b05b3a18c1f521c1503",
  );
  expect(legacy).not.toBe(
    simulatorBootstrapTemplate(settings.operatorAccountId, settings.externalId, settings.region),
  );
});

function retainedStateClient(initial: Record<string, unknown> | undefined) {
  const state = { stack: initial, creates: 0, deletes: 0 };
  const client = {
    async send(command: unknown) {
      if (command instanceof DescribeStacksCommand)
        return { Stacks: state.stack ? [state.stack] : [] };
      if (command instanceof DeleteStackCommand) {
        state.deletes++;
        state.stack = undefined;
        return {};
      }
      if (command instanceof CreateStackCommand) {
        state.creates++;
        state.stack = {
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
  return { state, client };
}

const ownershipOf = (template: string) => [
  {
    Key: "tenkacloud:simulator-bootstrap",
    Value: createHash("sha256").update(template).digest("hex"),
  },
];

test("bootstrap replaces only the exact completed Hello World stack this installation created", async () => {
  const legacy = legacyHelloWorldBootstrapTemplate(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  const { state, client } = retainedStateClient({
    StackName: "tc-simulator-bootstrap",
    StackStatus: "CREATE_COMPLETE",
    Tags: ownershipOf(legacy),
  });
  await bootstrapSimulatorRole(client as never, settings);
  expect(state).toMatchObject({ deletes: 1, creates: 1 });
  expect(state.stack?.Tags).toEqual(
    ownershipOf(
      simulatorBootstrapTemplate(settings.operatorAccountId, settings.externalId, settings.region),
    ),
  );
  await bootstrapSimulatorRole(client as never, settings);
  expect(state).toMatchObject({ deletes: 1, creates: 1 });
});

test("bootstrap never deletes a legacy-looking stack from another installation or an unfinished one", async () => {
  const otherInstallation = legacyHelloWorldBootstrapTemplate(
    settings.operatorAccountId,
    "different-installation-external-id-1234",
    settings.region,
  );
  const own = legacyHelloWorldBootstrapTemplate(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  for (const stack of [
    {
      StackName: "tc-simulator-bootstrap",
      StackStatus: "CREATE_COMPLETE",
      Tags: ownershipOf(otherInstallation),
    },
    { StackName: "tc-simulator-bootstrap", StackStatus: "CREATE_FAILED", Tags: ownershipOf(own) },
    { StackName: "tc-simulator-bootstrap", StackStatus: "CREATE_COMPLETE" },
  ]) {
    const { state, client } = retainedStateClient(stack);
    await expect(bootstrapSimulatorRole(client as never, settings)).rejects.toThrow("conflicts");
    expect(state).toMatchObject({ deletes: 0, creates: 0 });
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
