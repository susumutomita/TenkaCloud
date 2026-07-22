/**
 * [Composite Runtime / Issues #2064, #2747] Reusable dispatch seam for an already-created
 * deployment job.
 *
 * This is the single provider-neutral handoff into `RuntimeDeployInput`. Composite bindings are
 * supplied as `parameters`; single-provider callers omit them and preserve their previous payload.
 */

import type { ProblemRuntimeAdapter, RuntimeDeployInput } from "../shared/runtime/adapter.js";

export interface PreparedDeploymentDispatch {
  readonly adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  readonly jobId: string;
  readonly tenantId: string;
  readonly problemId: string;
  readonly problemDir: string;
  readonly teamSlug: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly competitorRoleArn?: string;
  readonly externalIdParameterName?: string;
  readonly challengePayloadUrl?: string;
  /** Explicit Composite output bindings after all sensitivity and dependency checks. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export async function dispatchPreparedDeployment(input: PreparedDeploymentDispatch): Promise<void> {
  const deployInput: RuntimeDeployInput = {
    jobId: input.jobId,
    correlationId: input.jobId,
    tenantId: input.tenantId,
    problemId: input.problemId,
    problemDir: input.problemDir,
    teamSlug: input.teamSlug,
    namePrefix: input.namePrefix,
    region: input.region,
    awsAccountId: input.awsAccountId,
    ...(input.competitorRoleArn ? { competitorRoleArn: input.competitorRoleArn } : {}),
    ...(input.externalIdParameterName
      ? { externalIdParameterName: input.externalIdParameterName }
      : {}),
    ...(input.challengePayloadUrl ? { challengePayloadUrl: input.challengePayloadUrl } : {}),
    ...(input.parameters && Object.keys(input.parameters).length > 0
      ? { parameters: input.parameters }
      : {}),
  };
  await input.adapter.deploy(deployInput);
}
