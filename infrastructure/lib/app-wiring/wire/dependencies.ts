import type { AdminConsoleHostingStack } from "../../admin-console-hosting.js";
import type { AdminConsoleRuntimeConfigStack } from "../../admin-console-runtime-config-stack.js";
import type { AdminConsoleInsightStack } from "../../admin-insight/admin-console-insight-stack.js";
import type { BootstrapTemplateStack } from "../../bootstrap-template/bootstrap-template-stack.js";
import type { ChallengePayloadStack } from "../../challenge-payload/challenge-payload-stack.js";
import type { ControlPlaneStack } from "../../control-plane-stack.js";
import type { ObservabilityStack } from "../../observability/cloudwatch-dashboard-stack.js";
import type { ProblemDeployBackendStack } from "../../problem-deploy/problem-deploy-backend-stack.js";
import type { ServerlessSaaSPipeline } from "../../tenant-pipeline/serverless-saas-pipeline.js";
import type { TenantTemplateStack } from "../../tenant-template/tenant-template-stack.js";

/**
 * Issue #766 wire-split: stack 間の deploy 順序を pin する `addDependency()` 群を 1 ヶ所に集約する。
 *
 * `addDependency` は CFn manifest (= deploy 順序メタデータ) にのみ効き、 各 stack の template JSON には
 * 影響しない。 だが install.sh / `cdk deploy --all` の順序を旧 `bin/infrastructure.ts` と完全一致させ、
 * manifest を byte 一致に保つため、 呼び出し順を従来と同じに保つ (= 物理差分 0 件の invariant)。
 *
 * 全 stack を生成し終えた後で 1 回だけ呼ぶ。 `challengePayloadStack` は config 次第で undefined
 * (= 立てない) なので、 存在するときだけ依存 edge を張る。
 */
export function registerStackDependencies(stacks: {
  readonly adminConsoleHostingStack: AdminConsoleHostingStack;
  readonly controlPlaneStack: ControlPlaneStack;
  readonly challengePayloadStack: ChallengePayloadStack | undefined;
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
  readonly tenantTemplateStack: TenantTemplateStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
  readonly serverlessSaaSPipeline: ServerlessSaaSPipeline;
  readonly observabilityStack: ObservabilityStack;
  readonly adminConsoleRuntimeConfigStack: AdminConsoleRuntimeConfigStack;
}): void {
  const {
    adminConsoleHostingStack,
    controlPlaneStack,
    challengePayloadStack,
    problemDeployBackendStack,
    bootstrapTemplateStack,
    tenantTemplateStack,
    adminConsoleInsightStack,
    serverlessSaaSPipeline,
    observabilityStack,
    adminConsoleRuntimeConfigStack,
  } = stacks;

  controlPlaneStack.addDependency(adminConsoleHostingStack);

  // deploy 順序: ChallengePayloadStack の bucket が先に立ってから ProblemDeployBackend を deploy
  // しないと、 Worker Lambda が起動時に bucket name を IAM policy で参照する経路で
  // race condition が起きる。 explicit dependency で順序を pin。
  if (challengePayloadStack) {
    problemDeployBackendStack.addDependency(challengePayloadStack);
  }

  tenantTemplateStack.addDependency(problemDeployBackendStack);
  tenantTemplateStack.addDependency(bootstrapTemplateStack);

  adminConsoleInsightStack.addDependency(controlPlaneStack);
  adminConsoleInsightStack.addDependency(problemDeployBackendStack);
  adminConsoleInsightStack.addDependency(bootstrapTemplateStack);
  adminConsoleInsightStack.addDependency(tenantTemplateStack);

  observabilityStack.addDependency(controlPlaneStack);
  observabilityStack.addDependency(problemDeployBackendStack);
  observabilityStack.addDependency(adminConsoleInsightStack);
  observabilityStack.addDependency(bootstrapTemplateStack);
  observabilityStack.addDependency(tenantTemplateStack);
  observabilityStack.addDependency(serverlessSaaSPipeline);

  adminConsoleRuntimeConfigStack.addDependency(observabilityStack);
  adminConsoleRuntimeConfigStack.addDependency(adminConsoleHostingStack);
  adminConsoleRuntimeConfigStack.addDependency(controlPlaneStack);
  adminConsoleRuntimeConfigStack.addDependency(adminConsoleInsightStack);
  adminConsoleRuntimeConfigStack.addDependency(tenantTemplateStack);
  adminConsoleRuntimeConfigStack.addDependency(serverlessSaaSPipeline);
  adminConsoleRuntimeConfigStack.addDependency(problemDeployBackendStack);
}
