/**
 * [Issue #1268] Problem runtime adapter abstraction.
 *
 * The deploy path resolves a `ProblemRuntimeAdapter` from the problem's normalized runtime
 * descriptor and the provider contexts wired for that deployment. A missing exact adapter or
 * provider context raises `RuntimeNotSupportedError` before any cloud mutation; it never falls
 * back to another provider.
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
  /** optional presigned URL for private problem payloads. */
  readonly challengePayloadUrl?: string;
  /**
   * [Composite Runtime / Issue #2747] The ONE typed, provider-neutral parameter contract: bound
   * values `composite-dispatch.ts` resolved from an upstream target's declared, non-sensitive (or
   * explicitly `allowSensitive`) outputs, keyed by the downstream parameter name the target's
   * `inputs` declared. Every adapter merges this map into its own provider-specific transport
   * (AWS CFn `Parameters`, GCP Infra Manager `inputs`, Azure Deployment Stack `parameters`, Sakura
   * AppRun `env`) alongside its own platform-injected identifiers — reserved-name collisions are
   * already rejected at plan-validation time (`@tenkacloud/problem-runtime` `validateInputsShape`).
   * Undefined / empty for a single-provider (non-Composite) deploy, preserving byte-identical
   * behavior for every problem that does not declare Composite `inputs`.
   */
  readonly parameters?: Readonly<Record<string, string>>;
}

/**
 * [Composite Runtime / Issue #2747] Merge bound Composite input values (`RuntimeDeployInput.parameters`)
 * into a provider's platform-injected parameter/env/input map. Every provider-owned adapter
 * (`AzureBicepRuntimeAdapter`, `GcpInfraManagerRuntimeAdapter`, `SakuraAppRunRuntimeAdapter`) calls
 * this from `deploy()` instead of repeating the merge inline, so the reserved-name-collision
 * rationale — collisions with the platform-injected identifiers already in `platformInjected` are
 * rejected at plan-validation time (`@tenkacloud/problem-runtime` `validateInputsShape`), so this
 * spread cannot silently shadow them — is documented in exactly one place.
 */
export function mergeCompositeParameters<T extends Readonly<Record<string, string>>>(
  platformInjected: T,
  parameters: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return { ...platformInjected, ...parameters };
}

/**
 * Include `parameters` as a single optional key only when it is defined and non-empty. Shared by
 * `AwsCloudFormationRuntimeAdapter` and `dispatchPreparedDeployment`, both of which must preserve
 * the byte-identical legacy event/dispatch shape for single-provider (non-Composite) deploys —
 * omitting the field entirely rather than serializing `parameters: {}`.
 */
export function optionalParametersField(parameters: Readonly<Record<string, string>> | undefined): {
  readonly parameters?: Readonly<Record<string, string>>;
} {
  return parameters && Object.keys(parameters).length > 0 ? { parameters } : {};
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
 * values). Each adapter projects provider-specific outputs into this map.
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
 * Problem runtime adapter. Implementations represent one `<provider>/<engine>` pair.
 *
 * The interface is intentionally small (deploy / collectOutputs / getStatus /
 * destroy) so contributors do not infer that the platform is provider-aware
 * beyond what it promises. Any richer capability needs an implementation and
 * adapter tests in the same PR.
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
 * Thrown when a problem's normalized runtime has no adapter configured for this deployment.
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
   * - `reserved`: a recognized provider/engine whose account-gated context is not configured.
   * - `container`: a **local-only** container problem (`docker/compose`) —
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
      return `Runtime ${pair} is recognized but is not configured for this deployment — its provider credentials or client are unavailable, so no adapter can run.`;
    }
    if (opts.container) {
      return `Runtime ${pair} is a local-only container problem — run it with \`make local\`; it is not cloud-deployable.`;
    }
    return `Runtime ${pair} is not a recognized executable runtime (check metadata.runtime for typos). No adapter is registered for this runtime.`;
  }
}
