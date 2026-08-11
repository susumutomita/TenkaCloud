import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — Outputs", () => {
  const tpl = synthDefault();

  it("should expose DeploymentsTableName and DeployCreateStateMachineArn as Outputs", () => {
    const outputs = tpl.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["DeploymentsTableName", "DeployCreateStateMachineArn"]),
    );
  });

  it("should expose ProblemEndpointsTableName as an Output", () => {
    const outputs = tpl.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["ProblemEndpointsTableName"]));
  });

  it("Issue #1053: should expose CompetitorBootstrapTemplateUrl as an Output", () => {
    // hosting を AdminConsoleHostingStack から移管したため、 本 stack が出力 owner。
    // SaaS の AdminConsoleHosting と Lite / SaaS の ApplicationAdminConsoleHosting が
    // cross-stack ref で受け取る。
    const outputs = tpl.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["CompetitorBootstrapTemplateUrl"]),
    );
  });

  it("should include CompetitorAccountsTableName in Outputs", () => {
    const outputs = tpl.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["CompetitorAccountsTableName"]));
  });
});

describe("ProblemDeployBackendStack (MVP-1) — Issue #1053: CompetitorBootstrapHosting (公開 S3 hosting)", () => {
  const tpl = synthDefault();

  it("should create 1 additional public-read S3 bucket (migrated from the old AdminConsoleHostingStack)", () => {
    // ParticipantPortal 等で別 bucket もあるため count assert は避け、 public-read 設定の
    // ある bucket が存在することで pin。
    tpl.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        }),
      }),
    );
  });
});

describe("ProblemDeployBackendStack (MVP-1) — legacy 経路の廃止", () => {
  const tpl = synthDefault();

  it("should not create the legacy DeployApiGateway (HTTP API)", () => {
    tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
  });
});
