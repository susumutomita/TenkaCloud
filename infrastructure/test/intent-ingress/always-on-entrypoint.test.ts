import { fileURLToPath } from "node:url";
import type { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import {
  buildIntentIngressApp,
  INTENT_INGRESS_STACK_ID,
  VERIFY_SECRET_PARAM_ENV,
} from "../../bin/tenkacloud-always-on";

// The entrypoint-guard path calls the real discoverProblemsCatalog (no injected hook), so mock it
// here to keep the argv-guard test independent of whether the problems/ submodule is checked out.
vi.mock("../../lib/utils/discover-problems-catalog", () => ({
  discoverProblemsCatalog: () => ({ "hello-world": "problems/challenges/hello-world" }),
}));

/**
 * ADR-049 Phase 4 (#2293) SLICE 2 — bin/tenkacloud-always-on.ts の手動デプロイ経路。
 *
 * bin file を import すると `new cdk.App()` の副作用が起きないよう、composition は exported
 * `buildIntentIngressApp` に切り出してある (entrypoint guard は argv 一致時のみ発火)。ここでは
 * その関数を fake env + fake catalog で駆動し、synth の shape を pin する:
 *   - IntentIngressStack が 1 つだけ立つ (他 stack を持ち込まない)
 *   - Function URL / nonce table / PutEvents grant が生成される
 *   - Free Tier 用の App-scope tag / aspect が効く
 *   - 必須 verify-secret env が無いと fail-loud する
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  [VERIFY_SECRET_PARAM_ENV]: "/tenkacloud/intent-ingress/verify-secret",
  CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME: "CompetitorAccounts",
  CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN:
    "arn:aws:dynamodb:us-east-1:111111111111:table/CompetitorAccounts",
  // #2365: audience pinning is required; the ingress cannot be deployed fail-open.
  CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE: "plane://tenka/ingress",
  CDK_PARAM_ENVIRONMENT: "test",
  CDK_PARAM_AWS_ACCOUNT_ID: "111111111111",
  CDK_PARAM_AWS_REGION: "us-east-1",
};

const FAKE_CATALOG = { "hello-world": "problems/challenges/hello-world" } as const;

function buildApp(env: NodeJS.ProcessEnv): App {
  return buildIntentIngressApp({
    env,
    binDir: "/repo/infrastructure/bin",
    // filesystem (= problems/ submodule) に依存しないよう catalog discovery を差し替える。
    discoverCatalog: () => FAKE_CATALOG,
  });
}

function findStack(app: App, stackName: string): Stack {
  const stack = app.node
    .findAll()
    .find((c): c is Stack => "stackName" in c && (c as Stack).stackName === stackName);
  if (!stack) throw new Error(`stack not found: ${stackName}`);
  return stack;
}

function synthIngress(env: NodeJS.ProcessEnv = BASE_ENV): Template {
  const app = buildApp(env);
  return Template.fromStack(findStack(app, INTENT_INGRESS_STACK_ID));
}

describe("bin/tenkacloud-always-on.ts (ADR-049 Phase 4 / #2293 SLICE 2)", () => {
  it("should synthesize exactly one IntentIngressStack and nothing else", () => {
    const app = buildApp(BASE_ENV);
    const stackNames = app.node
      .findAll()
      .filter((c): c is Stack => "stackName" in c && "templateFile" in c)
      .map((c) => c.stackName);
    expect(stackNames).toEqual([INTENT_INGRESS_STACK_ID]);
  });

  it("should expose an unauthenticated Function URL (JWS is the auth)", () => {
    synthIngress().hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  it("should provision a 1/1 PROVISIONED nonce table with a TTL attribute", () => {
    synthIngress().hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("should grant events:PutEvents so the frozen event can be re-emitted", () => {
    synthIngress().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: "events:PutEvents" })]),
      }),
    });
  });

  it("should inject the verify-secret param name into the ingress Lambda env", () => {
    synthIngress().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VERIFY_SECRET_PARAM: "/tenkacloud/intent-ingress/verify-secret",
          COMPETITOR_ACCOUNTS_TABLE_NAME: "CompetitorAccounts",
          DEPLOY_ENVIRONMENT: "test",
        }),
      },
    });
  });

  it("should create a local EventBus when no bus ARN is provided (standalone)", () => {
    synthIngress().resourceCountIs("AWS::Events::EventBus", 1);
  });

  it("should import the deploy bus and create no local EventBus when CDK_PARAM_EVENT_BUS_ARN is set", () => {
    const t = synthIngress({
      ...BASE_ENV,
      CDK_PARAM_EVENT_BUS_ARN: "arn:aws:events:us-east-1:111111111111:event-bus/tenkacloud-deploy",
    });
    t.resourceCountIs("AWS::Events::EventBus", 0);
  });

  it("should pass the required audience + optional allowlists from comma-separated env into the Lambda", () => {
    const t = synthIngress({
      ...BASE_ENV,
      CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE: "plane://tenka/ingress",
      CDK_PARAM_INTENT_INGRESS_ALLOWED_TENANT_IDS: " tenant-a , tenant-b ",
      CDK_PARAM_INTENT_INGRESS_ALLOWED_EVENT_IDS: "event-a",
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          EXPECTED_AUDIENCE: "plane://tenka/ingress",
          ALLOWED_TENANT_IDS: "tenant-a,tenant-b",
          ALLOWED_EVENT_IDS: "event-a",
        }),
      },
    });
  });

  it("should tag every resource with Project=TenkaCloud for Free-Tier cost allocation", () => {
    synthIngress().hasResourceProperties("AWS::DynamoDB::Table", {
      Tags: Match.arrayWith([{ Key: "Project", Value: "TenkaCloud" }]),
    });
  });

  it("should throw loudly when the required verify-secret env is missing", () => {
    const { [VERIFY_SECRET_PARAM_ENV]: _omitted, ...envWithoutSecret } = BASE_ENV;
    expect(() => buildApp(envWithoutSecret)).toThrow(VERIFY_SECRET_PARAM_ENV);
  });

  it("should throw loudly when the required verify-secret env is blank", () => {
    expect(() => buildApp({ ...BASE_ENV, [VERIFY_SECRET_PARAM_ENV]: "   " })).toThrow(
      VERIFY_SECRET_PARAM_ENV,
    );
  });

  it.each([
    "CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME",
    "CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN",
    // #2365: audience pinning is required — the ingress must never deploy fail-open.
    "CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE",
  ])("should throw loudly when required %s is missing", (name) => {
    const env = { ...BASE_ENV };
    delete env[name];
    expect(() => buildApp(env)).toThrow(name);
  });

  it("should skip Lambda bundling when CDK_SKIP_BUNDLING=1 is set", () => {
    // Fast synth-shape passthrough (mirrors bin/infrastructure.ts): the bundling-stacks context is
    // emptied so `make check-synth`-style runs never bundle the ingress Lambda.
    const app = buildApp({ ...BASE_ENV, CDK_SKIP_BUNDLING: "1" });
    expect(app.node.tryGetContext("aws:cdk:bundling-stacks")).toEqual([]);
    expect(Template.fromStack(findStack(app, INTENT_INGRESS_STACK_ID))).toBeDefined();
  });

  it("should treat an all-whitespace allowlist CSV as no allowlist", () => {
    // parseCsv drops empty items; an all-whitespace value folds to undefined (allowlist disabled).
    synthIngress({
      ...BASE_ENV,
      CDK_PARAM_INTENT_INGRESS_ALLOWED_TENANT_IDS: " , , ",
    }).hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ ALLOWED_TENANT_IDS: Match.absent() }) },
    });
  });

  it("should build the app when the file is invoked as the CDK entrypoint (argv guard)", async () => {
    // Drive the thin argv-guard shim: point argv[1] at the module path so the guard fires on import.
    const modPath = fileURLToPath(new URL("../../bin/tenkacloud-always-on.ts", import.meta.url));
    const savedArgv1 = process.argv[1];
    const hadSecret = VERIFY_SECRET_PARAM_ENV in process.env;
    const savedSecret = process.env[VERIFY_SECRET_PARAM_ENV];
    const savedTableName = process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME;
    const savedTableArn = process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN;
    const savedAudience = process.env.CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE;
    process.argv[1] = modPath;
    process.env[VERIFY_SECRET_PARAM_ENV] = "/tenkacloud/intent-ingress/verify-secret";
    process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME = "CompetitorAccounts";
    process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN =
      "arn:aws:dynamodb:us-east-1:111111111111:table/CompetitorAccounts";
    process.env.CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE = "plane://tenka/ingress";
    vi.resetModules();
    try {
      await expect(import("../../bin/tenkacloud-always-on")).resolves.toBeDefined();
    } finally {
      process.argv[1] = savedArgv1;
      if (hadSecret) process.env[VERIFY_SECRET_PARAM_ENV] = savedSecret;
      else delete process.env[VERIFY_SECRET_PARAM_ENV];
      if (savedTableName === undefined) delete process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME;
      else process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME = savedTableName;
      if (savedTableArn === undefined) delete process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN;
      else process.env.CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN = savedTableArn;
      if (savedAudience === undefined)
        delete process.env.CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE;
      else process.env.CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE = savedAudience;
      vi.resetModules();
    }
  });

  it("should not fire the entrypoint guard when argv carries no script path", async () => {
    // Exercises the `process.argv[1] ? ... : ""` fallback: with no script path the guard stays inert.
    const savedArgv1 = process.argv[1];
    process.argv[1] = "";
    vi.resetModules();
    try {
      await expect(import("../../bin/tenkacloud-always-on")).resolves.toBeDefined();
    } finally {
      process.argv[1] = savedArgv1;
      vi.resetModules();
    }
  });
});
