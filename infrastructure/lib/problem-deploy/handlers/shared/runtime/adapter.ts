/**
 * [ADR-023 / Issue #1268] Problem runtime adapter abstraction.
 *
 * Today the deploy worker is hard-wired to AWS / CloudFormation: it publishes a
 * `DeployCreateRequested` event, the Step Functions state machine fans out to
 * CodeBuild, and CodeBuild runs `aws cloudformation deploy` in the competitor
 * account. That path is correct for AWS-only problems.
 *
 * Per ADR-023 we will eventually support provider-specific problems (Azure /
 * GCP / Kubernetes) bound to the same deploy backend. To avoid bolting
 * provider switches into the deploy handler, the deploy path resolves a
 * `ProblemRuntimeAdapter` from the problem's normalized runtime descriptor.
 *
 * Phase 1 (this issue): the only registered adapter is
 * `AwsCloudFormationRuntimeAdapter`. It wraps the existing
 * `publishProblemEvent` flow byte-for-byte. Any other normalized runtime is
 * rejected via `RuntimeNotSupportedError` BEFORE any cloud mutation, so a
 * mis-shipped Azure problem cannot create a stack-shaped artifact in AWS.
 *
 * Phase 2+ will introduce new adapters without changing this interface.
 */

import type { RuntimeDescriptor } from "@tenkacloud/problem-runtime";

/**
 * Coarse runtime status. Provider-specific statuses (e.g. CFn
 * `CREATE_IN_PROGRESS` / `UPDATE_ROLLBACK_FAILED`) must be projected onto this
 * 6-state enum by each adapter so callers outside the runtime layer do not
 * branch on provider terminology.
 *
 * Mapping examples for AWS / CloudFormation:
 *   - `pending`     — pre-AssumeRole, before CFn knows about the stack
 *   - `deploying`   — CREATE_IN_PROGRESS / UPDATE_IN_PROGRESS
 *   - `ready`       — CREATE_COMPLETE / UPDATE_COMPLETE
 *   - `failed`      — CREATE_FAILED / ROLLBACK_COMPLETE / UPDATE_ROLLBACK_*
 *   - `destroying`  — DELETE_IN_PROGRESS
 *   - `destroyed`   — DELETE_COMPLETE / stack not found
 */
export type RuntimeStatus =
  | "pending"
  | "deploying"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed";

/**
 * Normalized runtime descriptor. Canonical definition lives in
 * `@tenkacloud/problem-runtime` (the single source of truth shared by the deploy
 * worker and the problem CLI, #1423); `ProblemRuntime` is the deploy-side name
 * for it so existing call sites keep reading naturally.
 */
export type ProblemRuntime = RuntimeDescriptor;

/**
 * Inputs for `adapter.deploy(...)`. Kept narrow on purpose; adapter
 * implementations should not reach back into Lambda env / SDK clients
 * directly — everything flows through this object so unit tests can pin it.
 */
export interface RuntimeDeployInput {
  readonly jobId: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly problemId: string;
  readonly problemDir: string;
  readonly teamSlug: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
  /** Cross-account AssumeRole target. AWS adapter only. */
  readonly competitorRoleArn?: string;
  /** SSM SecureString path. AWS adapter only. */
  readonly externalIdParameterName?: string;
  /** ADR-008: optional presigned URL for private problem payloads. */
  readonly challengePayloadUrl?: string;
}

/** Adapter-side outcome of `deploy`. */
export interface RuntimeDeployResult {
  /** Coarse normalized status reflecting the post-call state. */
  readonly status: RuntimeStatus;
}

export interface RuntimeCollectOutputsInput {
  readonly jobId: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
}

/**
 * Provider-independent map of deploy outputs (e.g. endpoint URLs / flag
 * values). AWS adapter maps CloudFormation Outputs into this map; future
 * adapters do the analogous projection.
 */
export type RuntimeOutputs = Readonly<Record<string, string>>;

export interface RuntimeStatusInput {
  readonly jobId: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
}

export interface RuntimeDestroyInput {
  readonly jobId: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly competitorRoleArn?: string;
  readonly externalIdParameterName?: string;
}

export interface RuntimeDestroyResult {
  readonly status: RuntimeStatus;
}

/**
 * Problem runtime adapter. Implementations represent one
 * `<provider>/<engine>` pair. Only AWS / CloudFormation is registered today.
 *
 * The interface is intentionally small (deploy / collectOutputs / getStatus /
 * destroy) so contributors do not infer that the platform is provider-aware
 * beyond what ADR-023 promises. Anything richer should be added in a separate
 * PR with the matching ADR amendment.
 */
export interface ProblemRuntimeAdapter {
  readonly provider: string;
  readonly engine: string;

  deploy(input: RuntimeDeployInput): Promise<RuntimeDeployResult>;
  collectOutputs(input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs>;
  getStatus(input: RuntimeStatusInput): Promise<RuntimeStatus>;
  destroy(input: RuntimeDestroyInput): Promise<RuntimeDestroyResult>;
}

/**
 * Thrown when a problem's normalized runtime has no registered adapter — i.e.
 * the metadata declares e.g. `azure/bicep` but the platform only knows
 * `aws/cloudformation` today.
 *
 * This is a LOUD failure on purpose. Per AGENTS.md "no silent fallbacks": we
 * never substitute a different adapter, we never quietly degrade. The
 * deploy-handler converts this to an HTTP 4xx so the operator sees the
 * mismatch before any cloud mutation runs.
 */
export class RuntimeNotSupportedError extends Error {
  /**
   * The runtime classification distinguishes the rejection reason (the failure is
   * always loud — no adapter, no cloud mutation — only the operator-facing message
   * differs):
   *   - `reserved`: a **planned** provider/engine (ADR-026/ADR-027, tracker #1408 —
   *     known roadmap, no adapter registered yet).
   *   - `container`: a **local-only** container problem (ADR-023 `docker/compose`) —
   *     deliberately not cloud-deployable; run it with `make local`.
   *   - otherwise: an **unknown** runtime (likely a typo in `metadata.runtime`).
   * Classification is supplied by the caller (`registry.selectAdapter`) so this
   * module stays free of a circular import back into `normalize`.
   */
  constructor(
    public readonly runtime: ProblemRuntime,
    opts: { readonly reserved?: boolean; readonly container?: boolean } = {},
  ) {
    super(RuntimeNotSupportedError.messageFor(runtime, opts));
    this.name = "RuntimeNotSupportedError";
  }

  private static messageFor(
    runtime: ProblemRuntime,
    opts: { readonly reserved?: boolean; readonly container?: boolean },
  ): string {
    const pair = `${runtime.provider}/${runtime.engine}`;
    if (opts.reserved) {
      return `Runtime ${pair} is a planned provider/engine (ADR-026/ADR-027, tracker #1408) but is not yet executable in this platform version — no adapter is registered.`;
    }
    if (opts.container) {
      return `Runtime ${pair} is a local-only container problem (ADR-023) — run it with \`make local\`; it is not cloud-deployable.`;
    }
    return `Runtime ${pair} is not a recognized executable runtime (check metadata.runtime for typos). Only aws/cloudformation is supported today (ADR-023 D4).`;
  }
}
