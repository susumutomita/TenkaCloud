import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ObservabilityStack } from "../../lib/observability/cloudwatch-dashboard-stack";

function synthDefault(
  cfnDeploy?: string,
  problemDeployProjectName: string | null = "tenkacloud-problem-deploy",
): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ObservabilityStack(app, "ObservabilityStack", {
    environment: "test",
    stateMachines: {
      deployCreateArn: "arn:aws:states:ap-northeast-1:123456789012:stateMachine:DeployCreate",
      deployDeleteArn: "arn:aws:states:ap-northeast-1:123456789012:stateMachine:DeployDelete",
    },
    codeBuildProjectNames: {
      problemDeploy: problemDeployProjectName ?? undefined,
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
      // Issue #2291: Lambda deploy path (CfnDeploy). Present only when deployViaLambda is ON.
      ...(cfnDeploy ? { cfnDeploy } : {}),
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

function widgetCount(template: Template): number {
  const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
  const dashboard = Object.values(dashboards)[0] as {
    Properties?: { DashboardBody?: unknown };
  };
  const bodyValue = dashboard.Properties?.DashboardBody;
  // DashboardBody is an `Fn::Join` (region/account tokens are interpolated into the JSON string).
  // Reconstruct the JSON by concatenating the literal parts and substituting tokens with a
  // placeholder so the result stays valid JSON, then count the `widgets` array length.
  const bodyString =
    typeof bodyValue === "string"
      ? bodyValue
      : ((bodyValue as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"]?.[1] ?? [])
          .map((part) => (typeof part === "string" ? part : "TOKEN"))
          .join("");
  return (JSON.parse(bodyString) as { widgets: unknown[] }).widgets.length;
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

  it("should add a CfnDeploy Lambda widget to the dashboard when the function name is provided", () => {
    const withCfnDeploy = synthDefault("cfn-deploy");
    const body = dashboardBody(withCfnDeploy);

    // The Lambda-path deploy widget carries its own title and plots the CfnDeploy function.
    expect(body).toContain("Deploy chain - Lambda (CfnDeploy)");
    // AWS/Lambda metrics render as [namespace, metricName, "FunctionName", <name>, ...] in the body.
    expect(body).toContain("FunctionName");
    expect(body).toContain("cfn-deploy");
    // One extra widget (row) is appended relative to the default (flag-off) dashboard.
    expect(widgetCount(withCfnDeploy)).toBe(widgetCount(tpl) + 1);
  });

  it("should NOT add the CfnDeploy Lambda widget when the name is absent", () => {
    const body = dashboardBody(tpl);

    // Default-safe: flag-off leaves the dashboard byte-identical (no Lambda-path deploy widget).
    expect(body).not.toContain("Deploy chain - Lambda (CfnDeploy)");
    expect(widgetCount(tpl)).toBe(8);
  });

  it("should omit the retired deploy CodeBuild metric in Lambda mode", () => {
    expect(dashboardBody(synthDefault(undefined, null))).not.toContain("tenkacloud-problem-deploy");
  });
});
