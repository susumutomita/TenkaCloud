import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ObservabilityStack } from "../../lib/observability/cloudwatch-dashboard-stack";

function synthDefault(): Template {
  const app = new cdk.App();
  const stack = new ObservabilityStack(app, "ObservabilityStack", {
    environment: "test",
    stateMachines: {
      deployCreateArn: "arn:aws:states:ap-northeast-1:123456789012:stateMachine:DeployCreate",
      deployDeleteArn: "arn:aws:states:ap-northeast-1:123456789012:stateMachine:DeployDelete",
    },
    codeBuildProjectNames: {
      problemDeploy: "tenkacloud-problem-deploy",
      provisioning: "tenkacloud-saas-provisioning",
    },
    dynamoDbTableNames: {
      deployments: "Deployments",
      events: "Events",
      teams: "Teams",
      competitorAccounts: "CompetitorAccounts",
      problemEndpoints: "ProblemEndpoints",
      tenantMappingTable: "TenantMappingTable",
    },
    lambdaFunctionNames: {
      deployApi: "deploy-api",
      eventApi: "event-api",
      participantPortal: "participant-portal-lambda",
      adminInsight: "admin-insight",
      competitorAccounts: "competitor-accounts",
      externalIdAudit: "external-id-audit",
      genericScoring: "generic-scoring",
    },
    apiGateways: {
      controlPlane: {
        kind: "http",
        label: "control-plane",
        apiId: "control-plane-api",
        stage: "$default",
      },
      tenant: {
        kind: "rest",
        label: "tenant",
        apiName: "TenantAPI-pooled",
        stage: "prod",
      },
      problemDeploy: {
        kind: "http",
        label: "problem-deploy",
        apiId: "problem-deploy-api",
        stage: "$default",
      },
      adminInsight: {
        kind: "http",
        label: "admin-insight",
        apiId: "admin-insight-api",
        stage: "$default",
      },
    },
  });
  return Template.fromStack(stack);
}

function dashboardBody(template: Template): string {
  const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
  const dashboard = Object.values(dashboards)[0] as {
    Properties?: { DashboardBody?: unknown };
  };
  return JSON.stringify(dashboard.Properties?.DashboardBody);
}

describe("ObservabilityStack", () => {
  const tpl = synthDefault();

  it("should create 1 CloudWatch Dashboard resource", () => {
    tpl.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    tpl.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: "tenkacloud-observability-test",
    });
  });

  it("DashboardBody should include deploy chain / DDB / Lambda / ApiGateway monitoring targets", () => {
    const body = dashboardBody(tpl);

    for (const expected of [
      "Deploy chain",
      "DeployCreate",
      "DeployDelete",
      "tenkacloud-saas-provisioning",
      "DDB tables",
      "Deployments",
      "Events",
      "Teams",
      "CompetitorAccounts",
      "ProblemEndpoints",
      "TenantMappingTable",
      "Lambda",
      "deploy-api",
      "event-api",
      "participant-portal-lambda",
      "admin-insight",
      "competitor-accounts",
      "external-id-audit",
      "generic-scoring",
      "ApiGateway",
      "control-plane",
      "tenant",
      "problem-deploy",
      "p50",
      "p99",
    ]) {
      expect(body).toContain(expected);
    }
  });
});
