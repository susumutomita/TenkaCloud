import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";
import { TenkaCloudLiteStack } from "../lib/tenkacloud-lite";

/**
 * Issue #778: bin/tenkacloud-lite.ts は `make lite-up` から
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

  // 注: 既存 test 規約 (= problem-deploy-backend-stack.test.ts の `synthParticipantPortalLambdaOnly`)
  // と同じ理由で `participantPortal` を test では渡さない (= CI で `apps/participant-portal/dist`
  // asset が無いと CDK BucketDeployment が CannotFindAsset で fail する)。 bin entry 本体は
  // `participantPortal: { runtimeConfig: "default-dev-mock" }` を渡すが、 wiring (= stack 数 /
  // EventBus / AppPlaneCore / 禁止 stack 排除 / deps) の verification には participant portal
  // は不要。 実 deploy 時 (= `make lite-up`) は frontend build 後に走るので dist は存在する。
  const problemDeployBackend = new ProblemDeployBackendStack(
    app,
    "tenkacloud-lite-problem-deploy",
    {
      ...stackEnv,
      sourceBucketName: "tenkacloud-source-placeholder",
      sourceObjectKey: "source.zip",
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      problemsScoring: {},
      problemsEndpoints: {},
      problemsPhases: {},
      problemsVisibility: {},
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

function findStack(app: cdk.App, stackName: string): cdk.Stack {
  const stack = app.node.findAll().find((construct): construct is cdk.Stack => {
    return construct instanceof cdk.Stack && construct.stackName === stackName;
  });
  if (!stack) throw new Error(`stack not found: ${stackName}`);
  return stack;
}

function synthLiteFixture() {
  const app = buildLiteApp();
  const problemDeployStack = findStack(app, "tenkacloud-lite-problem-deploy");
  const liteStack = findStack(app, "tenkacloud-lite");
  const assembly = app.synth();
  const problemDeployArtifact = assembly.stacks.find(
    (stack) => stack.stackName === problemDeployStack.stackName,
  );
  const liteArtifact = assembly.stacks.find((stack) => stack.stackName === liteStack.stackName);
  if (!problemDeployArtifact || !liteArtifact) throw new Error("lite synth artifacts are missing");
  return {
    assembly,
    liteStack,
    problemDeployTemplate: Template.fromJSON(problemDeployArtifact.template),
    liteTemplate: Template.fromJSON(liteArtifact.template),
  };
}

describe("bin/tenkacloud-lite.ts (#778)", () => {
  // ProblemDeployBackend の NodejsFunction bundling が重いので wiring 一式を 1 度だけ synth する。
  const fixture = synthLiteFixture();

  it("should synth only the 2 stacks `tenkacloud-lite-problem-deploy` + `tenkacloud-lite`", () => {
    const liteStacks = fixture.assembly.stacks.filter((s) => s.stackName.startsWith("tenkacloud-"));
    const names = liteStacks.map((s) => s.stackName).sort();
    expect(names).toEqual(["tenkacloud-lite", "tenkacloud-lite-problem-deploy"]);
  });

  it("ProblemDeployBackend (Lite mode) should create 1 local EventBus when eventBusArn is omitted", () => {
    fixture.problemDeployTemplate.resourceCountIs("AWS::Events::EventBus", 1);
  });

  it("Lite stack side should create 1 set of AppPlaneCore (UserPool + REST API + CloudFront)", () => {
    fixture.liteTemplate.resourceCountIs("AWS::Cognito::UserPool", 1);
    fixture.liteTemplate.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    fixture.liteTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("Lite stack should not include ControlPlane / Tenant-Pipeline / Bootstrap / AdminConsoleInsight", () => {
    const stackNames = fixture.assembly.stacks.map((s) => s.stackName);
    for (const forbidden of [
      "tenkacloud-control-plane",
      "tenkacloud-bootstrap",
      "tenkacloud-admin-console-insight",
      "tenkacloud-admin-console-hosting",
    ]) {
      expect(stackNames).not.toContain(forbidden);
    }
    // ServerlessSaaSPipeline (= CodePipeline) も作らない。
    const allTemplates = fixture.assembly.stacks.map((s) => Template.fromJSON(s.template));
    for (const template of allTemplates) {
      template.resourceCountIs("AWS::CodePipeline::Pipeline", 0);
    }
  });

  it("Lite stack should explicitly depend on the ProblemDeploy stack (cross-stack Lambda ref)", () => {
    const deps = fixture.liteStack.dependencies.map((d) => d.stackName);
    expect(deps).toContain("tenkacloud-lite-problem-deploy");
  });
});
