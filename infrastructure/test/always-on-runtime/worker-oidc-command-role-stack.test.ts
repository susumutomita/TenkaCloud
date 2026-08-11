import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { scanTemplateForIamDescriptions } from "../../../scripts/lib/iam-description-ascii";
import { buildCommandRoleApp } from "../../bin/tenkacloud-always-on-command.js";
import {
  normalizeIssuer,
  WorkerOidcCommandRoleStack,
} from "../../lib/always-on-runtime/worker-oidc-command-role-stack.js";

/**
 * Issue #2555: Worker OIDC command-seam trust.
 * Pins the security-critical invariants of the federated command role:
 *   - trust policy hard-pins aud (StringEquals) + sub (StringLike, command-scoped)
 *   - the permission surface is exactly one statement: events:PutEvents to the
 *     one bus, conditioned on the frozen source `tenkacloud.deploy`
 *   - the OIDC provider is created when absent and imported when an ARN is supplied
 */

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-1";
const ISSUER = "https://tenkacloud-always-on-control-plane.example.workers.dev";
const ISSUER_HOST = "tenkacloud-always-on-control-plane.example.workers.dev";
const BUS_ARN = `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/tenkacloud-deploy`;

function synth(props?: {
  workerIssuerUrl?: string;
  existingOidc?: boolean;
  subjectClaimPattern?: string;
  commandRoleName?: string;
}): Template {
  const app = new App();
  const stack = new WorkerOidcCommandRoleStack(app, "Test", {
    env: { account: ACCOUNT, region: REGION },
    workerIssuerUrl: props?.workerIssuerUrl ?? ISSUER,
    deployEventBusArn: BUS_ARN,
    ...(props?.existingOidc
      ? { existingOidcProviderArn: `arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER_HOST}` }
      : {}),
    ...(props?.subjectClaimPattern ? { subjectClaimPattern: props.subjectClaimPattern } : {}),
    ...(props?.commandRoleName ? { commandRoleName: props.commandRoleName } : {}),
  });
  return Template.fromStack(stack);
}

describe("normalizeIssuer (issuer contract)", () => {
  it("should strip a trailing slash so the issuer matches the Worker origin-derived iss claim", () => {
    expect(normalizeIssuer(`${ISSUER}/`)).toEqual({
      providerUrl: ISSUER,
      conditionKeyPrefix: ISSUER_HOST,
    });
  });

  it("should reject a non-https issuer", () => {
    expect(() => normalizeIssuer("http://insecure.example")).toThrow(/https/u);
  });

  it("should reject an issuer with a query or fragment", () => {
    expect(() => normalizeIssuer("https://worker.example?x=1")).toThrow(/query or fragment/u);
    expect(() => normalizeIssuer("https://worker.example#frag")).toThrow(/query or fragment/u);
  });

  it("should reject a scheme-only issuer", () => {
    expect(() => normalizeIssuer("https://")).toThrow(/hostname/u);
  });
});

describe("WorkerOidcCommandRoleStack (#2555)", () => {
  it("should hard-pin the OIDC trust policy aud (StringEquals) and sub (StringLike, command-scoped)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                [`${ISSUER_HOST}:aud`]: "sts.amazonaws.com",
              }),
              StringLike: Match.objectLike({
                [`${ISSUER_HOST}:sub`]: "tenkacloud:always-on:command:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should name the role tenkacloud-alwayson-command by default", () => {
    synth().hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tenkacloud-alwayson-command",
    });
  });

  it("should let the sub claim pattern and role name be overridden", () => {
    const t = synth({
      subjectClaimPattern: "tenkacloud:always-on:command:tenant-a:*",
      commandRoleName: "tenkacloud-alwayson-command-staging",
    });
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tenkacloud-alwayson-command-staging",
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                [`${ISSUER_HOST}:sub`]: "tenkacloud:always-on:command:tenant-a:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should grant only events:PutEvents to the one bus, conditioned on the frozen source", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: "Allow",
            Action: "events:PutEvents",
            Resource: BUS_ARN,
            Condition: { StringEquals: { "events:source": "tenkacloud.deploy" } },
          }),
        ],
      },
    });
  });

  it("should attach exactly one inline policy with exactly one statement (least-privilege pin)", () => {
    // Imported-provider variant isolates the command role from the CDK OIDC
    // custom-resource infra, so the only policy in the template is ours.
    const t = synth({ existingOidc: true });
    const policies = Object.values(t.findResources("AWS::IAM::Policy"));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.Properties?.PolicyDocument?.Statement).toHaveLength(1);
  });

  it("should never use a wildcard action or wildcard resource in the command role policies", () => {
    const t = synth({ existingOidc: true });
    for (const policy of Object.values(t.findResources("AWS::IAM::Policy"))) {
      for (const statement of policy.Properties?.PolicyDocument?.Statement ?? []) {
        expect(JSON.stringify(statement.Action)).not.toContain("*");
        expect(JSON.stringify(statement.Resource)).not.toContain('"*"');
      }
    }
  });

  it("should attach no managed policy to the command role", () => {
    const t = synth({ existingOidc: true });
    t.resourceCountIs("AWS::IAM::Role", 1);
    const role = Object.values(t.findResources("AWS::IAM::Role"))[0];
    const managed = role?.Properties?.ManagedPolicyArns;
    expect(managed === undefined || (Array.isArray(managed) && managed.length === 0)).toBe(true);
  });

  it("should register the Worker issuer as an OIDC provider with the sts audience when none is imported", () => {
    const t = synth();
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
    t.hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: ISSUER,
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  it("should import an existing OIDC provider when an ARN is supplied", () => {
    const t = synth({ existingOidc: true });
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });

  it("should normalize a trailing slash off the issuer before registering it", () => {
    const t = synth({ workerIssuerUrl: `${ISSUER}/` });
    t.hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", { Url: ISSUER });
    t.hasOutput("IssuerUrlOutput", { Value: ISSUER });
  });

  it("should emit Outputs for the role ARN and the enforced sub pattern", () => {
    const t = synth();
    t.hasOutput("CommandRoleArnOutput", { Value: Match.anyValue() });
    t.hasOutput("SubjectClaimPatternOutput", { Value: "tenkacloud:always-on:command:*" });
  });

  it("should synthesize no DynamoDB table and no Lambda ingress (the seam carries no standing pieces)", () => {
    const t = synth({ existingOidc: true });
    t.resourceCountIs("AWS::DynamoDB::Table", 0);
    t.resourceCountIs("AWS::Lambda::Function", 0);
  });

  it("should keep every IAM Role/ManagedPolicy description within the IAM Latin-1 range", () => {
    const findings = scanTemplateForIamDescriptions(synth().toJSON());
    expect(findings).toEqual([]);
  });
});

describe("buildCommandRoleApp (bin/tenkacloud-always-on-command.ts)", () => {
  const REQUIRED_ENV = {
    CDK_PARAM_AWS_ACCOUNT_ID: ACCOUNT,
    CDK_PARAM_AWS_REGION: REGION,
    CDK_PARAM_ALWAYS_ON_ISSUER_URL: ISSUER,
    CDK_PARAM_EVENT_BUS_ARN: BUS_ARN,
  };

  it.each([
    ["CDK_PARAM_AWS_ACCOUNT_ID", /CDK_PARAM_AWS_ACCOUNT_ID/u],
    ["CDK_PARAM_AWS_REGION", /CDK_PARAM_AWS_REGION/u],
    ["CDK_PARAM_ALWAYS_ON_ISSUER_URL", /CDK_PARAM_ALWAYS_ON_ISSUER_URL/u],
    ["CDK_PARAM_EVENT_BUS_ARN", /CDK_PARAM_EVENT_BUS_ARN/u],
  ])("should throw loudly when %s is missing", (key, pattern) => {
    const env: NodeJS.ProcessEnv = { ...REQUIRED_ENV };
    delete env[key];
    expect(() => buildCommandRoleApp({ env })).toThrow(pattern);
  });

  it("should synthesize the command-seam stack when the required env is set", () => {
    const app = buildCommandRoleApp({ env: { ...REQUIRED_ENV } });
    const assembly = app.synth();
    const stack = assembly.stacks.find((s) => s.stackName === "tenkacloud-always-on-command");
    if (!stack) throw new Error("tenkacloud-always-on-command stack was not synthesized");
    Template.fromJSON(stack.template).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: "sts:AssumeRoleWithWebIdentity" })]),
      },
    });
  });

  it("should honor env overrides for the provider ARN, sub claim, and role name", () => {
    const app = buildCommandRoleApp({
      env: {
        ...REQUIRED_ENV,
        CDK_PARAM_ALWAYS_ON_OIDC_PROVIDER_ARN: `arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER_HOST}`,
        CDK_PARAM_ALWAYS_ON_COMMAND_SUBJECT: "tenkacloud:always-on:command:tenant-a:*",
        CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME: "tenkacloud-alwayson-command-staging",
      },
    });
    const assembly = app.synth();
    const stack = assembly.stacks.find((s) => s.stackName === "tenkacloud-always-on-command");
    if (!stack) throw new Error("tenkacloud-always-on-command stack was not synthesized");
    const t = Template.fromJSON(stack.template);
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "tenkacloud-alwayson-command-staging",
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                [`${ISSUER_HOST}:sub`]: "tenkacloud:always-on:command:tenant-a:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should synth the app when invoked as the CDK entrypoint (argv guard)", async () => {
    // Point argv[1] at the module path so the top-level guard fires on import.
    const modPath = fileURLToPath(
      new URL("../../bin/tenkacloud-always-on-command.ts", import.meta.url),
    );
    const savedArgv1 = process.argv[1];
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    process.argv[1] = modPath;
    vi.resetModules();
    try {
      await expect(import("../../bin/tenkacloud-always-on-command")).resolves.toBeDefined();
    } finally {
      process.argv[1] = savedArgv1;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });
});
