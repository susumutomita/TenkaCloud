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
 * Budget email subscriptions are opt-in. systemAdminEmail identifies the platform
 * administrator; it is not consent to receive every budget confirmation.
 */
export function budgetNotificationEmails(
  config: Pick<AppConfig, "systemAdminEmail" | "budgetAlarmEmails">,
): string[] | undefined {
  const recipients = Array.from(new Set(config.budgetAlarmEmails ?? []));
  return recipients.length > 0 ? recipients : undefined;
}

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
    notificationEmails: budgetNotificationEmails(config),
    costAllocationTags: { Project: ["TenkaCloud"] },
  });
  new FreeTierAlarms(args.observabilityStack, "FreeTierAlarms", {
    notificationTopic: budget.topic,
    lambdaFunctionNames: freeTierLambdaNames(args),
    dynamoDbTableNames: freeTierTableNames(args),
    apiGateways: freeTierApiGateways(args),
  });
}

// Issue #2239: FreeTierAlarms construct ID は `label` (deterministic, caller が一意性を保証)
// だけを使う。 `name` は Lambda functionName / DDB tableName の実値 (cross-stack 参照だと CFn
// token) で、 alarmName / metric dimension にのみ使う。
function freeTierLambdaNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
}): ConstructorParameters<typeof FreeTierAlarms>[2]["lambdaFunctionNames"] {
  const problem = args.problemDeployBackendStack;
  return [
    { label: "deploy-api", name: problem.deployApiLambda.functionName },
    { label: "event-api", name: problem.eventApiLambda.functionName },
    { label: "admin-insight", name: args.adminConsoleInsightStack.lambdaFunctionName },
    { label: "competitor-accounts", name: problem.competitorAccountsApiLambda.functionName },
    { label: "external-id-audit", name: problem.externalIdAuditLambda.functionName },
    { label: "generic-scoring", name: problem.genericScoringLambda.functionName },
    ...(problem.participantPortalLambda
      ? [{ label: "participant-portal", name: problem.participantPortalLambda.functionName }]
      : []),
  ];
}

function freeTierTableNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
}): ConstructorParameters<typeof FreeTierAlarms>[2]["dynamoDbTableNames"] {
  const problem = args.problemDeployBackendStack;
  return [
    // Issue #2440 / #2441: 純 SQL backend では Deployments/Events/Teams table 自体が無いので
    // アラームも作らない (= freeTierLambdaNames の participantPortal と同じ conditional-spread
    // パターン)。
    ...(problem.deploymentsTable
      ? [{ label: "deployments", name: problem.deploymentsTable.tableName }]
      : []),
    ...(problem.eventsTable ? [{ label: "events", name: problem.eventsTable.tableName }] : []),
    ...(problem.teamsTable ? [{ label: "teams", name: problem.teamsTable.tableName }] : []),
    // Issue #2442: 純 SQL backend では CompetitorAccounts table 自体が無いのでアラームも作らない
    // (= 上の deployments/events/teams と同じ conditional-spread パターン)。
    ...(problem.competitorAccountsTable
      ? [{ label: "competitor-accounts", name: problem.competitorAccountsTable.tableName }]
      : []),
    // Issue #2442: 純 SQL backend では ProblemEndpoints table 自体が無いのでアラームも作らない
    // (= 上の deployments/events/teams と同じ conditional-spread パターン)。
    ...(problem.problemEndpointsTable
      ? [{ label: "problem-endpoints", name: problem.problemEndpointsTable.tableName }]
      : []),
    { label: "tenant-mapping", name: args.bootstrapTemplateStack.tenantMappingTable.tableName },
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
