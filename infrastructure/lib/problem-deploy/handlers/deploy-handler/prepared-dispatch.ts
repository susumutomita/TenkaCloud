/**
 * [Composite Runtime / Issue #2064] Reusable dispatch seam for an already-created
 * deployment job.
 *
 * `dispatchPreparedDeployment` is the single place that turns a prepared
 * deployment (its job id + identity + resolved connection data) into the narrow
 * {@link RuntimeDeployInput} and invokes the runtime adapter. It is a
 * behavior-preserving extraction of the inline `adapter.deploy(...)` call from
 * `startDeployment`: the payload — including `correlationId = jobId` and the
 * conditional AWS-only / challenge fields — is built byte-for-byte as before, so
 * the AWS/CloudFormation EventBridge detail is unchanged.
 *
 * Ownership boundary:
 *   - This function owns ONLY the adapter dispatch. On failure it rethrows the
 *     original error unchanged; status compensation stays with the caller.
 *   - It does NOT create / delete a DynamoDB row, generate ids / keys /
 *     timestamps, or select the adapter. Adapter SELECTION stays at the call site
 *     because the existing pre-mutation runtime gate (`selectAdapter` →
 *     `RuntimeNotSupportedError`) must run BEFORE any DynamoDB access — a property
 *     the `deploy-runtime-dispatch` tests enforce. The caller selects the adapter
 *     (per target, for composite) and hands it in here already prepared.
 */

import type { ProblemRuntimeAdapter, RuntimeDeployInput } from "../shared/runtime/adapter.js";

/** An already-prepared deployment job, ready to dispatch through its adapter. */
export interface PreparedDeploymentDispatch {
  /** The adapter already selected for this job's runtime (the gate ran upstream). */
  readonly adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  readonly jobId: string;
  readonly tenantId: string;
  readonly problemId: string;
  readonly problemDir: string;
  readonly teamSlug: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
  /** Cross-account AssumeRole target. AWS only. */
  readonly competitorRoleArn?: string;
  /** SSM SecureString path for the tenant ExternalId. AWS only. */
  readonly externalIdParameterName?: string;
  /** ADR-008 presigned URL for a private problem payload. */
  readonly challengePayloadUrl?: string;
}

/**
 * Dispatch a prepared deployment through its already-selected runtime adapter.
 * Rethrows the adapter's original error so the caller can run its own
 * compensation. Performs no row mutation and returns nothing (the adapter result
 * is not consumed here, matching the legacy inline behavior).
 */
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
  };
  await input.adapter.deploy(deployInput);
}
