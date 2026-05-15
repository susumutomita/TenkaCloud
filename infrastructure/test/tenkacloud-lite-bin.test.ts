import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";
import { TenkaCloudLiteStack } from "../lib/tenkacloud-lite";

/**
 * Issue #778 ADR-016 Phase 5: bin/tenkacloud-lite.ts は `make lite-up` から
 * `cdk deploy` で呼ばれる app entry。 ここでは entry の配線を **直接 reproducer
 * する** (= bin file を import すると `new cdk.App()` の副作用が起きるため、
 * 同等の wiring を test 内で再構築して assertion を pin する)。
 *
 * 重要な invariant:
 *   - tenkacloud-lite-problem-deploy + tenkacloud-lite の 2 stack だけが立つ
 *   - ControlPlane / BootstrapTemplate / TenantTemplate / Pipeline /
 *     AdminConsoleInsight / AdminConsoleHosting は 一切 作らない
 *   - Lite stack は ProblemDeploy stack に depend する (= cross-stack import)
 *   - eventBusArn 省略で local EventBus が 1 つ作られる (= Phase 2 PR-#791)
 *   - TenantId="local" 固定 (= CfnOutput)
 */

function buildLiteApp(): cdk.App {
  const app = new cdk.App();
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(7));
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  const stackEnv = {
    env: { account: "123456789012", region: "ap-northeast-1" },
  } as const;

  const problemDeployBackend = new ProblemDeployBackendStack(
    app,
    "tenkacloud-lite-problem-deploy",
    {
      ...stackEnv,
      sourceBucketName: "serverless-saas-placeholder",
      sourceObjectKey: "source.zip",
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      problemsScoring: {},
      problemsEndpoints: {},
      problemsPhases: {},
      problemsVisibility: {},
      participantPortal: { runtimeConfig: "default-dev-mock" },
      environmentName: "development",
    },
  );
  cdk.Aspects.of(problemDeployBackend).add(new DynamoDbLowCapacity(1, 1));

  const liteStack = new TenkaCloudLiteStack(app, "tenkacloud-lite", {
    ...stackEnv,
    environment: "development",
    deployApiLambda: problemDeployBackend.deployApiLambda,
    eventApiLambda: problemDeployBackend.eventApiLambda,
    competitorAccountsApiLambda: problemDeployBackend.competitorAccountsApiLambda,
    ...(problemDeployBackend.participantPortalUrl
      ? { participantPortalUrl: problemDeployBackend.participantPortalUrl }
      : {}),
  });
  cdk.Aspects.of(liteStack).add(new DynamoDbLowCapacity(1, 1));
  liteStack.addDependency(problemDeployBackend);

  return app;
}

describe("bin/tenkacloud-lite.ts (#778 ADR-016 Phase 5)", () => {
  it("`tenkacloud-lite-problem-deploy` + `tenkacloud-lite` の 2 stack だけが synth されるべき", () => {
    const app = buildLiteApp();
    const assembly = app.synth();
    const liteStacks = assembly.stacks.filter((s) => s.stackName.startsWith("tenkacloud-"));
    const names = liteStacks.map((s) => s.stackName).sort();
    expect(names).toEqual(["tenkacloud-lite", "tenkacloud-lite-problem-deploy"]);
  }, 30_000);

  it("ProblemDeployBackend (Lite mode) は eventBusArn 省略で local EventBus を 1 つ作るべき", () => {
    const app = buildLiteApp();
    const problemDeployStack = app.node
      .findAll()
      .find((c) => c instanceof cdk.Stack && c.stackName === "tenkacloud-lite-problem-deploy");
    expect(problemDeployStack).toBeDefined();
    const template = Template.fromStack(problemDeployStack as cdk.Stack);
    template.resourceCountIs("AWS::Events::EventBus", 1);
  }, 30_000);

  it("Lite stack 側は AppPlaneCore (= UserPool + REST API + CloudFront) を 1 セット作るべき", () => {
    const app = buildLiteApp();
    const liteStack = app.node
      .findAll()
      .find((c) => c instanceof cdk.Stack && c.stackName === "tenkacloud-lite");
    expect(liteStack).toBeDefined();
    const template = Template.fromStack(liteStack as cdk.Stack);
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  }, 30_000);

  it("Lite stack は ControlPlane / Tenant-Pipeline / Bootstrap / AdminConsoleInsight を持ち込まないべき", () => {
    const app = buildLiteApp();
    const assembly = app.synth();
    const stackNames = assembly.stacks.map((s) => s.stackName);
    for (const forbidden of [
      "tenkacloud-control-plane",
      "tenkacloud-bootstrap",
      "tenkacloud-admin-console-insight",
      "tenkacloud-admin-console-hosting",
    ]) {
      expect(stackNames).not.toContain(forbidden);
    }
    // ServerlessSaaSPipeline (= CodePipeline) も作らない。
    const allTemplates = assembly.stacks.map((s) => Template.fromJSON(s.template));
    for (const template of allTemplates) {
      template.resourceCountIs("AWS::CodePipeline::Pipeline", 0);
    }
  }, 30_000);

  it("Lite stack は ProblemDeploy stack に明示的に depend するべき (= cross-stack Lambda ref)", () => {
    const app = buildLiteApp();
    const liteStack = app.node
      .findAll()
      .find((c): c is cdk.Stack => c instanceof cdk.Stack && c.stackName === "tenkacloud-lite");
    expect(liteStack).toBeDefined();
    const deps = liteStack?.dependencies.map((d) => d.stackName) ?? [];
    expect(deps).toContain("tenkacloud-lite-problem-deploy");
  }, 30_000);
});
