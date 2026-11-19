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
  reviewedProblemBootstrapTemplateV2,
  SIMULATOR_COMMAND_ROLE,
  SIMULATOR_DEPLOY_ROLE,
  simulatorBootstrapTemplate,
} from "../simulator-bootstrap";

const ownedOutputs = [
  { OutputKey: "RoleArn", OutputValue: `arn:aws:iam::000000000000:role/${SIMULATOR_DEPLOY_ROLE}` },
  {
    OutputKey: "CommandRoleArn",
    OutputValue: `arn:aws:iam::000000000000:role/${SIMULATOR_COMMAND_ROLE}`,
  },
];

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
  // Battle guests: only this account's EC2 resources in the region, and the Battle's own profile.
  const battle =
    /^arn:aws:ec2:ap-northeast-1:(000000000000:(vpc|subnet|internet-gateway|route-table|security-group|instance|network-interface|volume)|:image)\/\*$|^arn:aws:iam::000000000000:(instance-profile\/tc-hello-world-battle-\*-instance-profile|role\/tc-hello-world-battle-\*)$|^arn:aws:ssm:ap-northeast-1:000000000000:parameter\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-6\.1-x86_64$/u;
  for (const statement of role.Policies[0].PolicyDocument.Statement) {
    const resources: string[] = [statement.Resource].flat();
    expect(resources.length).toBeGreaterThan(0);
    const guest = statement.Action.some(
      (action: string) =>
        action.startsWith("ec2:") ||
        action.endsWith("InstanceProfile") ||
        action === "ssm:GetParameters",
    );
    for (const resource of resources) {
      if (guest || resource.includes("tc-hello-world-battle-")) expect(resource).toMatch(battle);
      else expect(resource).toMatch(reviewed);
    }
    expect(statement.Action.every((action: string) => !action.endsWith(":*"))).toBe(true);
    // Handing out a role is limited to the Lambda and Battle problems' own roles.
    if (statement.Action.some((action: string) => action === "iam:PassRole"))
      expect(
        resources.every(
          (resource) =>
            resource.endsWith("/tc-lambda-settings-viewer-*") ||
            resource.endsWith("/tc-hello-world-battle-*"),
        ),
      ).toBe(true);
    if (statement.Action.some((action: string) => action.startsWith("lambda:")))
      expect(resources.every((resource) => resource.includes(":tc-lambda-settings-viewer-*"))).toBe(
        true,
      );
  }
  const actions = role.Policies[0].PolicyDocument.Statement.flatMap(
    (statement: { Action: string[] }) => statement.Action,
  );
  expect(actions).toContain("lambda:CreateFunction");
  expect(actions).toContain("iam:PassRole");
  expect(actions).not.toContain("lambda:InvokeFunction");
  expect(actions).not.toContain("lambda:UpdateFunctionCode");
  expect(actions).toContain("ec2:RunInstances");
  // The deploy role never runs commands on a guest.
  expect(
    actions.some((action: string) => action.startsWith("ssm:") && action.includes("Command")),
  ).toBe(false);
});

test("the Battle command role runs only the catalog document on tagged Battle guests and cannot deploy", () => {
  const template = JSON.parse(
    simulatorBootstrapTemplate(settings.operatorAccountId, settings.externalId, settings.region),
  );
  const role = template.Resources.SimulatorCommandRole.Properties;
  expect(role.RoleName).toBe(SIMULATOR_COMMAND_ROLE);
  expect(role.AssumeRolePolicyDocument).toEqual(
    template.Resources.CompetitorDeployRole.Properties.AssumeRolePolicyDocument,
  );
  expect(template.Outputs.CommandRoleArn).toEqual({
    Value: { "Fn::GetAtt": ["SimulatorCommandRole", "Arn"] },
  });
  const statements = role.Policies[0].PolicyDocument.Statement;
  const actions = new Set(
    statements.flatMap((statement: { Action: string[] }) => statement.Action),
  );
  expect([...actions].sort()).toEqual([
    "ssm:GetCommandInvocation",
    "ssm:ListCommands",
    "ssm:SendCommand",
  ]);
  const onInstances = statements.find((statement: { Resource: string[] }) =>
    statement.Resource.some((resource) => resource.includes(":instance/")),
  );
  expect(onInstances.Condition).toEqual({
    StringEquals: { "ssm:resourceTag/TenkaCloud:Problem": "hello-world-battle" },
    StringLike: { "ssm:resourceTag/TenkaCloud:NamePrefix": "tc-hello-world-battle-*" },
  });
  const documents = statements.find((statement: { Resource: string[] }) =>
    statement.Resource.some((resource) => resource.includes(":document/")),
  );
  expect(documents.Resource).toEqual(["arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript"]);
});

test("the second released bootstrap template stays byte-identical so retained installs are recognised", () => {
  const released = reviewedProblemBootstrapTemplateV2(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  expect(createHash("sha256").update(released).digest("hex")).toBe(
    "f5cce7f924b33f4e0f7eabf7a5c5c8179b27ec2351ebec066a7eae381915eef2",
  );
  expect(released).not.toBe(
    simulatorBootstrapTemplate(settings.operatorAccountId, settings.externalId, settings.region),
  );
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
          Outputs: ownedOutputs,
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

const battle = { battle: true };
const withoutBattle = { battle: false };

test.each([
  ["Hello World", legacyHelloWorldBootstrapTemplate],
  ["reviewed-problem", reviewedProblemBootstrapTemplateV2],
])(
  "Battle bootstrap replaces only the exact completed %s stack this installation created",
  async (_, released) => {
    const legacy = released(settings.operatorAccountId, settings.externalId, settings.region);
    const { state, client } = retainedStateClient({
      StackName: "tc-simulator-bootstrap",
      StackStatus: "CREATE_COMPLETE",
      Tags: ownershipOf(legacy),
    });
    await bootstrapSimulatorRole(client as never, settings, battle);
    expect(state).toMatchObject({ deletes: 1, creates: 1 });
    expect(state.stack?.Tags).toEqual(
      ownershipOf(
        simulatorBootstrapTemplate(
          settings.operatorAccountId,
          settings.externalId,
          settings.region,
        ),
      ),
    );
    await bootstrapSimulatorRole(client as never, settings, battle);
    expect(state).toMatchObject({ deletes: 1, creates: 1 });
  },
);

test("without a Battle runtime, bootstrap creates the reviewed-problem template that released Simulators accept", async () => {
  const reviewed = reviewedProblemBootstrapTemplateV2(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  // Released Simulators before Battle support reject an inline policy statement with a Condition.
  const resources = JSON.parse(reviewed).Resources;
  expect(Object.keys(resources)).toEqual(["CompetitorDeployRole"]);
  for (const policy of resources.CompetitorDeployRole.Properties.Policies)
    for (const statement of policy.PolicyDocument.Statement)
      expect(statement.Condition).toBeUndefined();
  const { state, client } = retainedStateClient(undefined);
  await bootstrapSimulatorRole(client as never, settings, withoutBattle);
  expect(state).toMatchObject({ deletes: 0, creates: 1 });
  expect(state.stack?.Tags).toEqual(ownershipOf(reviewed));
});

test("without a Battle runtime, an owned reviewed-problem stack is reused and other owned stacks are replaced", async () => {
  const reviewed = reviewedProblemBootstrapTemplateV2(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  const reused = retainedStateClient({
    StackName: "tc-simulator-bootstrap",
    StackStatus: "CREATE_COMPLETE",
    Tags: ownershipOf(reviewed),
    Outputs: ownedOutputs.slice(0, 1),
  });
  await bootstrapSimulatorRole(reused.client as never, settings, withoutBattle);
  await bootstrapSimulatorRole(reused.client as never, settings, withoutBattle);
  expect(reused.state).toMatchObject({ deletes: 0, creates: 0 });
  for (const earlier of [legacyHelloWorldBootstrapTemplate, simulatorBootstrapTemplate]) {
    const { state, client } = retainedStateClient({
      StackName: "tc-simulator-bootstrap",
      StackStatus: "CREATE_COMPLETE",
      Tags: ownershipOf(earlier(settings.operatorAccountId, settings.externalId, settings.region)),
    });
    await bootstrapSimulatorRole(client as never, settings, withoutBattle);
    expect(state).toMatchObject({ deletes: 1, creates: 1 });
    expect(state.stack?.Tags).toEqual(ownershipOf(reviewed));
  }
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
    await expect(bootstrapSimulatorRole(client as never, settings, battle)).rejects.toThrow(
      "conflicts",
    );
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
          Outputs: ownedOutputs,
        };
        return {};
      }
      throw new Error("Unexpected write");
    },
  };
  await bootstrapSimulatorRole(client as never, settings, battle);
  await bootstrapSimulatorRole(client as never, settings, battle);
  expect(creates).toBe(1);
  await expect(
    bootstrapSimulatorRole(
      client as never,
      { ...settings, externalId: "different-installation-secret" },
      battle,
    ),
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
    bootstrapSimulatorRole(
      client as never,
      { ...settings, operatorAccountId: "123456789012" },
      withoutBattle,
    ),
  ).rejects.toThrow("native simulator");
  expect(calls).toBe(0);
  let failure: unknown;
  try {
    await bootstrapSimulatorRole(client as never, settings, withoutBattle);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("Simulator bootstrap failed");
  expect(String(failure)).not.toContain(settings.externalId);
});

test("bootstrap rejects an owned stack without the Battle command role output", async () => {
  const template = simulatorBootstrapTemplate(
    settings.operatorAccountId,
    settings.externalId,
    settings.region,
  );
  const { client } = retainedStateClient({
    StackName: "tc-simulator-bootstrap",
    StackStatus: "CREATE_COMPLETE",
    Tags: ownershipOf(template),
    Outputs: ownedOutputs.slice(0, 1),
  });
  await expect(bootstrapSimulatorRole(client as never, settings, battle)).rejects.toThrow(
    "conflicts",
  );
});
