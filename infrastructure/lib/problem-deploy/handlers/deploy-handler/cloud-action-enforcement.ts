import {
  type CloudActionEnforcementMode,
  type CloudActionPolicy,
  type CloudActionRiskContext,
  type CloudActionVerdict,
  evaluateCloudActionRisk,
  INTENT_VERSION,
} from "@TenkaCloud/trust-bridge";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { resolveDeploymentsRepository } from "./shared.js";
import type { DeploymentStatus, DeployResponse } from "./types.js";

/**
 * Issue #2019: staged enforcement gate for the single-deploy path.
 *
 * This is the *infrastructure-side* glue around the pure
 * `evaluateCloudActionRisk` policy in `@TenkaCloud/trust-bridge`. It:
 *
 *   1. Reads the opt-in `CLOUD_ACTION_ENFORCEMENT_MODE` env into a policy
 *      (default `"shadow"` = no behavior change, existing Lite events untouched).
 *   2. Resolves the risk context for *this* deploy. The first gated high-risk
 *      operation is **replacing a live stack**: a deploy whose `namePrefix`
 *      (= immutable CFn StackName for this problem+team) already has a
 *      non-terminal deployment in the tenant. Replacing a running competitor
 *      environment is the cleanest, most security-relevant signal available at
 *      the single-deploy gate, and it needs only a tenant-scoped GSI1 query.
 *   3. Asks the pure policy for a verdict (`allow` / `needs_approval` / `deny`).
 *
 * Cost discipline: the DDB lookup runs **only when enforcement is on**. In the
 * default `shadow` mode the gate is a single env compare and returns `allow`
 * with zero extra I/O — so the legacy deploy path is byte-for-byte unchanged.
 *
 * The first gated rule lives here (not in env) so the enforcement target is
 * explicit and reviewable: `deploy` + `replacesExistingStack`.
 */

/** The high-risk rule this slice enforces first. */
const REQUIRE_APPROVAL_RULES = [
  { actionType: "deploy" as const, conditions: { replacesExistingStack: true } },
] as const;

const ENFORCE: CloudActionEnforcementMode = "enforce";

/** Parse the opt-in env flag. Anything other than `"enforce"` → `"shadow"` (safe default). */
export function parseEnforcementMode(raw: string | undefined): CloudActionEnforcementMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow";
}

/** Build the policy the deploy gate evaluates against, from the env-derived mode. */
export function buildCloudActionPolicy(mode: CloudActionEnforcementMode): CloudActionPolicy {
  return { enforcementMode: mode, requireApprovalFor: REQUIRE_APPROVAL_RULES };
}

export interface ReplacementLookupDeps {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}

/**
 * True if a non-terminal deployment OTHER THAN `selfJobId` already holds this
 * `namePrefix` for the tenant (= a live CFn stack this deploy would replace).
 * Drains all GSI1 pages so a replacement target on a later page is not missed.
 *
 * `selfJobId` MUST be excluded: `startDeployment` writes the new row (status
 * `PENDING`, same `namePrefix`) BEFORE this gate runs, and GSI1 reads can already
 * see it. Without the exclusion the gate would count the deploy's own row as a
 * replacement target and falsely hold every first-ever deploy.
 */
async function replacesExistingStack(
  deps: ReplacementLookupDeps,
  tenantId: string,
  namePrefix: string,
  selfJobId: string,
): Promise<boolean> {
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(deps);
  const items = await repository.findByNamePrefix(tenantId, namePrefix);
  for (const item of items) {
    // Skip our own just-written row — it is not a stack we would "replace".
    if (item.jobId === selfJobId) {
      continue;
    }
    const status = (item.status ?? "PENDING") as DeploymentStatus;
    // Deleted-like rows are gone; FAILED rows left no live stack. Anything else
    // (PENDING / APPROVAL_PENDING / IN_PROGRESS / COMPLETE / DELETING) means a
    // stack with this name is — or is about to be — live, so this deploy would
    // replace it.
    if (status !== "FAILED" && !DELETED_LIKE_STATUSES.has(status)) {
      return true;
    }
  }
  return false;
}

export interface EvaluateDeployGateInput {
  readonly mode: CloudActionEnforcementMode;
  readonly deps: ReplacementLookupDeps;
  readonly tenantId: string;
  readonly namePrefix: string;
  /** This deploy's own jobId — excluded from the replacement lookup. */
  readonly jobId: string;
}

export interface DeployGateOutcome {
  readonly verdict: CloudActionVerdict;
  /** The context resolved while deciding (for audit / trace). */
  readonly context: CloudActionRiskContext;
}

/**
 * Resolve the risk context (only doing I/O when enforcing) and return the
 * policy verdict for this single deploy.
 */
export async function evaluateDeployGate(
  input: EvaluateDeployGateInput,
): Promise<DeployGateOutcome> {
  const policy = buildCloudActionPolicy(input.mode);
  // Cost-zero default: never touch DDB in shadow mode — the policy short-circuits
  // to "allow" regardless of context, so resolving facts would be wasted I/O.
  const context: CloudActionRiskContext =
    input.mode === ENFORCE
      ? {
          replacesExistingStack: await replacesExistingStack(
            input.deps,
            input.tenantId,
            input.namePrefix,
            input.jobId,
          ),
        }
      : {};
  // The intent's only policy-relevant field here is action.type; a minimal
  // well-formed intent keeps the gate decoupled from the full shadow-audit build.
  const verdict = evaluateCloudActionRisk(
    {
      version: INTENT_VERSION,
      requestId: input.namePrefix,
      nonce: input.namePrefix,
      source: { system: "tenkacloud", tenantId: input.tenantId, workloadId: "deploy-handler" },
      target: { provider: "aws", providerAccountRef: input.tenantId },
      action: { type: "deploy", engine: "cloudformation", requestedScopes: [] },
      constraints: {
        ttlSeconds: 900,
        expiresAt: new Date(0).toISOString(),
        allowPrivilegeEscalation: false,
      },
    },
    policy,
    context,
  );
  return { verdict, context };
}

export interface HoldForApprovalInput {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly jobId: string;
  readonly tenantId: string;
  /** Update timestamp (ISO 8601). */
  readonly nowIso: string;
}

/**
 * Flip a just-created deployment row from `PENDING` to `APPROVAL_PENDING` so it
 * is held for operator approval instead of being dispatched. The conditional
 * write only fires on our own `PENDING` row scoped to the tenant (defense in
 * depth against a concurrent transition), and notably **runs no AssumeRole /
 * CloudFormation** — that is the whole point of the hold.
 *
 * [Issue #2441 / Phase B2] The pre-seam call let a `ConditionalCheckFailedException`
 * propagate uncaught (no try/catch here) — the defense-in-depth check is meant to
 * fail loud. `markApprovalPending` folds the CCF into a `conflict` outcome instead
 * of throwing, so this rethrows on anything but `updated` to keep that fail-loud
 * behavior byte-identical.
 */
export async function holdForApproval(input: HoldForApprovalInput): Promise<void> {
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(input);
  const outcome = await repository.markApprovalPending(input.jobId, input.tenantId, input.nowIso);
  if (outcome.outcome !== "updated") {
    throw new Error(
      `holdForApproval: conditional PENDING -> APPROVAL_PENDING failed for jobId=${input.jobId} (outcome=${outcome.outcome})`,
    );
  }
}

export interface MaybeHoldDeployInput {
  readonly mode: CloudActionEnforcementMode;
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly problemId: string;
  readonly teamSlug: string;
  readonly namePrefix: string;
  readonly teamLoginKey: string;
  readonly expiresAt: number;
  readonly nowIso: string;
}

/**
 * Single enforcement entry point for `startDeployment`. Evaluates the policy
 * and, if the verdict is `needs_approval`, holds the deployment
 * (`PENDING → APPROVAL_PENDING`) and returns the held `DeployResponse`. Returns
 * `null` when the deploy may proceed (the default `shadow` path always returns
 * `null`, with zero extra I/O). Keeping the branch here keeps `startDeployment`
 * — already a long orchestrator — under the cognitive-complexity budget.
 */
export async function maybeHoldDeploy(input: MaybeHoldDeployInput): Promise<DeployResponse | null> {
  const gate = await evaluateDeployGate({
    mode: input.mode,
    deps: { runtime: input.runtime, ddb: input.ddb, tableName: input.tableName },
    tenantId: input.tenantId,
    namePrefix: input.namePrefix,
    jobId: input.jobId,
  });
  if (gate.verdict !== "needs_approval") {
    return null;
  }
  await holdForApproval({
    runtime: input.runtime,
    ddb: input.ddb,
    tableName: input.tableName,
    jobId: input.jobId,
    tenantId: input.tenantId,
    nowIso: input.nowIso,
  });
  logDeployTrace("deploy.create.held-for-approval", {
    jobId: input.jobId,
    correlationId: input.jobId,
    tenantId: input.tenantId,
    problemId: input.problemId,
    teamSlug: input.teamSlug,
    namePrefix: input.namePrefix,
    replacesExistingStack: gate.context.replacesExistingStack === true,
  });
  return {
    jobId: input.jobId,
    status: "APPROVAL_PENDING",
    namePrefix: input.namePrefix,
    teamLoginKey: input.teamLoginKey,
    expiresAt: input.expiresAt,
  };
}
