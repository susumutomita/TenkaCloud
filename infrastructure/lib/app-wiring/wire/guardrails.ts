import * as cdk from "aws-cdk-lib";
import type { AdminConsoleInsightStack } from "../../admin-insight/admin-console-insight-stack.js";
import type { AppConfig } from "../../app-config/types.js";
import type { BootstrapTemplateStack } from "../../bootstrap-template/bootstrap-template-stack.js";
import type { ControlPlaneStack } from "../../control-plane-stack.js";
import type { ObservabilityStack } from "../../observability/cloudwatch-dashboard-stack.js";
import { CostBudget } from "../../observability/cost-budget.js";
import { FreeTierAlarms } from "../../observability/free-tier-alarms.js";
import type { ProblemDeployBackendStack } from "../../problem-deploy/problem-deploy-backend-stack.js";
import type { TenantTemplateStack } from "../../tenant-template/tenant-template-stack.js";

/**
 * `execute-api` URL (= `https://<apiId>.execute-api.<region>.amazonaws.com/...`) から `apiId` を
 * CFn intrinsic だけで抽出する。 cross-stack ref した URL を synth 時に文字列分解できないため、
 * `Fn::Split` / `Fn::Select` で deploy 時に解決する。 observability 配線と FreeTierAlarms の双方で使う。
 */
export const apiIdFromExecuteApiUrl = (apiUrl: string): string =>
  cdk.Fn.select(0, cdk.Fn.split(".", cdk.Fn.select(2, cdk.Fn.split("/", apiUrl))));

/**
 * Issue #952 epic / cost guardrails: 月次 AWS Budget + Free Tier 使用量アラームを立てる。
 * limit / alarm 通知先は config から。 `monthlyCostLimitUsd` が 0 / 未指定なら何も立てない
 * (= legacy 互換、 CFn 物理差分 0 件)。
 */
export function addCostGuardrails(args: {
  readonly config: AppConfig;
  readonly observabilityStack: ObservabilityStack;
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
  readonly controlPlaneStack: ControlPlaneStack;
  readonly tenantTemplateStack: TenantTemplateStack;
}): void {
  const { config } = args;
  if (!config.monthlyCostLimitUsd || config.monthlyCostLimitUsd <= 0) return;
  const budget = new CostBudget(args.observabilityStack, "CostBudget", {
    budgetNamePrefix: `tenkacloud-${config.environment}`,
    monthlyLimitUsd: config.monthlyCostLimitUsd,
    notificationEmails: Array.from(
      new Set([config.systemAdminEmail, ...(config.budgetAlarmEmails ?? [])]),
    ),
    costAllocationTags: { Project: ["TenkaCloud"] },
  });
  new FreeTierAlarms(args.observabilityStack, "FreeTierAlarms", {
    notificationTopic: budget.topic,
    lambdaFunctionNames: freeTierLambdaNames(args),
    dynamoDbTableNames: freeTierTableNames(args),
    apiGateways: freeTierApiGateways(args),
  });
}

function freeTierLambdaNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
}): string[] {
  const problem = args.problemDeployBackendStack;
  return [
    problem.deployApiLambda.functionName,
    problem.eventApiLambda.functionName,
    args.adminConsoleInsightStack.lambdaFunctionName,
    problem.competitorAccountsApiLambda.functionName,
    problem.externalIdAuditLambda.functionName,
    problem.genericScoringLambda.functionName,
    ...(problem.participantPortalLambda ? [problem.participantPortalLambda.functionName] : []),
  ];
}

function freeTierTableNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
}): string[] {
  const problem = args.problemDeployBackendStack;
  return [
    problem.deploymentsTable.tableName,
    problem.eventsTable.tableName,
    problem.teamsTable.tableName,
    problem.competitorAccountsTable.tableName,
    problem.problemEndpointsTable.tableName,
    args.bootstrapTemplateStack.tenantMappingTable.tableName,
  ];
}

function freeTierApiGateways(args: {
  readonly controlPlaneStack: ControlPlaneStack;
  readonly tenantTemplateStack: TenantTemplateStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
}): ConstructorParameters<typeof FreeTierAlarms>[2]["apiGateways"] {
  return [
    {
      kind: "http",
      label: "control-plane",
      apiId: apiIdFromExecuteApiUrl(args.controlPlaneStack.regApiGatewayUrl),
      stage: "$default",
    },
    {
      kind: "rest",
      label: "tenant",
      apiName: args.tenantTemplateStack.tenantApiName,
      stage: args.tenantTemplateStack.tenantApiStageName,
    },
    {
      kind: "http",
      label: "admin-insight",
      apiId: args.adminConsoleInsightStack.apiId,
      stage: "$default",
    },
  ];
}
