import type { VerifiedCloudActionIntent } from "@TenkaCloud/trust-bridge";
import { buildStackPrefix, slugify } from "../problem-deploy/handlers/deploy-handler/naming.js";
import {
  type DeployCreateRequestedDetail,
  DeployCreateRequestedDetailSchema,
  type DeployDeleteRequestedDetail,
  DeployDeleteRequestedDetailSchema,
} from "../problem-deploy/handlers/shared/events.js";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ingress: frozen-detail builder.
 *
 * Translates the identifiers carried by a signature-verified `CloudActionIntent`
 * into the FROZEN EventBridge detail shapes consumed unchanged by
 * `deploy-event-rule.ts` and the deploy/delete state machines. The output is
 * validated against the authoritative `DeployCreate/DeleteRequestedDetailSchema`
 * (imported from the deploy backend, never redefined here), so a malformed
 * mapping is rejected loudly instead of emitting a non-conforming event.
 *
 * Mapping (intent identifier → frozen detail field):
 *   jobId          ← source.deploymentId ?? requestId   (deployment identity, else the
 *                                                         intent's unique request id)
 *   correlationId  ← requestId                            (cross-plane correlation)
 *   tenantId       ← source.tenantId
 *   problemId      ← source.problemId                     (required for a deploy)
 *   teamSlug       ← slugify(source.teamId)               (required for a deploy)
 *   region         ← target.region                        (required for a deploy)
 *   awsAccountId   ← target.providerAccountRef            (must be the 12-digit account)
 *   namePrefix /
 *   stackName      ← buildStackPrefix(problemId, teamId)  (platform's own helper)
 *
 * Field-derivation gaps (documented, not invented — see the PR report):
 *   - `problemDir` is NOT an intent identifier (the frozen schema carries no problem
 *     directory / category). It is resolved from the platform problems catalog
 *     (problemId → dir), mirroring the deploy handler's `problemsCatalog[problemId]`.
 *   - `competitorRoleArn` / `externalIdParameterName` are cross-account AssumeRole
 *     metadata the intent does not carry; they are left unset (both optional in the
 *     frozen schema). The downstream worker still resolves the verified competitor
 *     account for the tenant, so SLICE 1 re-emit stays same-account-safe.
 */

export interface DetailBuildConfig {
  /**
   * problemId → problemDir (e.g. `problems/challenges/hello-world`). Mirrors the deploy
   * handler's `problemsCatalog[problemId]`. Returns `undefined` for an unknown problem.
   */
  readonly resolveProblemDir: (problemId: string) => string | undefined;
}

export type DetailBuildFailureReason =
  | "problem-id-missing"
  | "team-id-missing"
  | "region-missing"
  | "unknown-problem-dir"
  | "detail-schema-invalid";

export type DeployCreateDetailResult =
  | { readonly ok: true; readonly detail: DeployCreateRequestedDetail }
  | {
      readonly ok: false;
      readonly reason: DetailBuildFailureReason;
      readonly details?: readonly string[];
    };

export type DeployDeleteDetailResult =
  | { readonly ok: true; readonly detail: DeployDeleteRequestedDetail }
  | {
      readonly ok: false;
      readonly reason: DetailBuildFailureReason;
      readonly details?: readonly string[];
    };

/** jobId is the deployment identity if the intent carries one, else the request id. */
function deriveJobId(intent: VerifiedCloudActionIntent): string {
  return intent.source.deploymentId ?? intent.requestId;
}

/**
 * Build the FROZEN `DeployCreateRequested` detail from a verified deploy intent.
 * Fails closed on any missing identifier or on a shape that the authoritative
 * schema rejects.
 */
export function buildDeployCreateDetail(
  intent: VerifiedCloudActionIntent,
  cfg: DetailBuildConfig,
): DeployCreateDetailResult {
  const problemId = intent.source.problemId;
  if (problemId === undefined) {
    return { ok: false, reason: "problem-id-missing" };
  }
  const teamId = intent.source.teamId;
  if (teamId === undefined) {
    return { ok: false, reason: "team-id-missing" };
  }
  const region = intent.target.region;
  if (region === undefined) {
    return { ok: false, reason: "region-missing" };
  }
  const problemDir = cfg.resolveProblemDir(problemId);
  if (problemDir === undefined) {
    return { ok: false, reason: "unknown-problem-dir" };
  }

  const candidate: DeployCreateRequestedDetail = {
    jobId: deriveJobId(intent),
    correlationId: intent.requestId,
    tenantId: intent.source.tenantId,
    problemId,
    problemDir,
    teamSlug: slugify(teamId),
    namePrefix: buildStackPrefix(problemId, teamId),
    region,
    awsAccountId: intent.target.providerAccountRef,
  };

  // Emit only what the authoritative frozen schema accepts. A non-conforming
  // identifier (e.g. an uppercase problemId, a non-12-digit account) is rejected
  // here rather than published as a poison event onto the deploy bus.
  const parsed = DeployCreateRequestedDetailSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "detail-schema-invalid",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, detail: parsed.data };
}

/**
 * Build the FROZEN `DeployDeleteRequested` detail from a verified destroy intent.
 * The stack name is derived with the platform's own `buildStackPrefix`, so it
 * matches the `namePrefix` a create for the same (problem, team) produced.
 */
export function buildDeployDeleteDetail(
  intent: VerifiedCloudActionIntent,
): DeployDeleteDetailResult {
  const problemId = intent.source.problemId;
  if (problemId === undefined) {
    return { ok: false, reason: "problem-id-missing" };
  }
  const teamId = intent.source.teamId;
  if (teamId === undefined) {
    return { ok: false, reason: "team-id-missing" };
  }
  const region = intent.target.region;
  if (region === undefined) {
    return { ok: false, reason: "region-missing" };
  }

  const candidate: DeployDeleteRequestedDetail = {
    jobId: deriveJobId(intent),
    correlationId: intent.requestId,
    tenantId: intent.source.tenantId,
    stackName: buildStackPrefix(problemId, teamId),
    region,
    awsAccountId: intent.target.providerAccountRef,
  };

  const parsed = DeployDeleteRequestedDetailSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "detail-schema-invalid",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, detail: parsed.data };
}
