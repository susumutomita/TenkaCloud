/**
 * [Composite Runtime / Issue #2076] Provider-neutral participant access
 * capability + lookup for one composite target.
 *
 * This module answers a single question safely: "for a composite target that
 * belongs to the authenticated participant team, what kind of access could the
 * platform offer?" It defines the contract and resolves the lookup ONLY — it
 * issues NO credentials, performs NO sign-in / federation / token exchange, and
 * makes NO provider API call. The AWS bridge that turns a `console` /
 * `cli-credentials` capability into an actual session is a later issue (#2077);
 * GCP / Azure / Sakura stop at `external-portal` (the platform may later publish
 * a provider portal URL — it does NOT imply an authenticated session here).
 *
 * Two pieces:
 *   1. {@link resolveTargetAccessCapability} — a pure, deterministic function of
 *      provider alone. AWS → `console` + `cli-credentials`; GCP / Azure / Sakura
 *      → `external-portal`; anything else → `unsupported`.
 *   2. {@link lookupTargetAccess} — resolves a target via the #2061 repository
 *      (GSI3 parent->target query) and projects it down to a secret-free
 *      {@link TargetAccessDescriptor}. A target from another team (or absent) is
 *      indistinguishable from not-found; a target that is not COMPLETE is
 *      not_ready. The descriptor NEVER carries the deployment row's provider
 *      configuration, role ARNs, account ids, tokens, secrets, or SSM names.
 *
 * Like {@link buildCompositeDetail} (#2073), this is read-only and additive: it
 * mutates nothing and only the composite-target access path calls it. Legacy
 * single-provider deployments are never routed here, so they gain no new
 * participant access API in this issue.
 */

import { z } from "zod";
import {
  type CompositeDeploymentRepositoryDeps,
  listCompositeTargets,
} from "./composite-repository.js";

/**
 * Providers a composite target may declare. `unsupported` is the safe sentinel
 * for a stored provider value the platform does not (yet) recognize — it keeps
 * the descriptor honest instead of mislabeling an unknown target as a known
 * cloud.
 */
export const TARGET_ACCESS_PROVIDERS = ["aws", "gcp", "azure", "sakura", "unsupported"] as const;
export type TargetAccessProvider = (typeof TARGET_ACCESS_PROVIDERS)[number];

/**
 * One provider-neutral access capability for a composite target.
 *   - `console`          — an interactive provider console (AWS today, via #2077).
 *   - `cli-credentials`  — short-lived CLI/SDK credentials (AWS today, via #2077).
 *   - `external-portal`  — the platform may later hand off to a provider portal
 *                          URL; it does NOT imply an authenticated session.
 *   - `unsupported`      — no access path is defined for this provider yet.
 */
export const TARGET_ACCESS_CAPABILITIES = [
  "console",
  "cli-credentials",
  "external-portal",
  "unsupported",
] as const;
export type TargetAccessCapability = (typeof TARGET_ACCESS_CAPABILITIES)[number];

/**
 * Secret-free description of how a participant could access one target. Carries
 * ONLY identity (targetId / targetDeploymentId), the resolved provider, and the
 * capability list. It deliberately omits every config / identity / secret field
 * a target row holds (competitorRoleArn, externalIdParameterName, awsAccountId,
 * region, namePrefix, teamLoginKey, runtimeEntry, …). Adding a field here is a
 * conscious decision to widen the participant-visible surface.
 */
export const TargetAccessDescriptorSchema = z.object({
  targetId: z.string(),
  targetDeploymentId: z.string(),
  provider: z.enum(TARGET_ACCESS_PROVIDERS),
  capability: z.array(z.enum(TARGET_ACCESS_CAPABILITIES)).readonly(),
});
export type TargetAccessDescriptor = z.infer<typeof TargetAccessDescriptorSchema>;

/**
 * The capability matrix (issue #2076). A pure function of provider — readiness
 * gating lives in {@link lookupTargetAccess}, which never reaches a target that
 * is not COMPLETE.
 */
const CAPABILITY_MATRIX: Record<TargetAccessProvider, readonly TargetAccessCapability[]> = {
  aws: ["console", "cli-credentials"],
  gcp: ["external-portal"],
  azure: ["external-portal"],
  sakura: ["external-portal"],
  unsupported: ["unsupported"],
};

/** Narrow a stored `runtimeProvider` to the known provider union (else `unsupported`). */
function normalizeProvider(raw: string): TargetAccessProvider {
  return (TARGET_ACCESS_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as TargetAccessProvider)
    : "unsupported";
}

/**
 * Resolve the access capabilities for a provider. Pure and deterministic: the
 * result depends only on the provider argument. The `status` argument documents
 * that capability is independent of readiness (readiness is gated upstream); it
 * does not influence the result.
 */
export function resolveTargetAccessCapability(
  provider: TargetAccessProvider,
  _status: string,
): readonly TargetAccessCapability[] {
  return CAPABILITY_MATRIX[normalizeProvider(provider)];
}

/** Input for a team-scoped composite target access lookup. */
export interface LookupTargetAccessInput {
  /** The authenticated participant team's login key — the access boundary. */
  readonly teamLoginKey: string;
  /** The composite parent the target belongs to (drives the GSI3 query). */
  readonly parentDeploymentId: string;
  /** The specific target deployment id the participant is asking about. */
  readonly targetDeploymentId: string;
}

/**
 * Result of a composite target access lookup. `not_found` covers both "no such
 * target" and "a target owned by another team" — the two are intentionally
 * indistinguishable so a participant cannot probe for other teams' targets.
 */
export type TargetAccessOutcome =
  | { kind: "ok"; descriptor: TargetAccessDescriptor }
  | { kind: "not_ready" }
  | { kind: "not_found" };

/**
 * Resolve participant access for one composite target.
 *
 * Steps:
 *   1. Query the parent's targets via the #2061 repository (GSI3).
 *   2. Find the requested `targetDeploymentId` that ALSO belongs to the calling
 *      team (`teamLoginKey`). A miss on either condition → `not_found` (a
 *      cross-team target is indistinguishable from a missing one).
 *   3. A target that is not COMPLETE → `not_ready`.
 *   4. Otherwise project to a secret-free {@link TargetAccessDescriptor} whose
 *      capability comes from the pure matrix.
 *
 * The caller is responsible for authenticating the participant team and passing
 * its `teamLoginKey`; this module only projects already-authenticated, team-
 * scoped rows and never returns provider config / credentials.
 */
export async function lookupTargetAccess(
  deps: CompositeDeploymentRepositoryDeps,
  input: LookupTargetAccessInput,
): Promise<TargetAccessOutcome> {
  const targets = await listCompositeTargets(deps, input.parentDeploymentId);

  // Team scoping AND target match are checked together so a cross-team target is
  // never told apart from a missing one.
  const target = targets.find(
    (t) => t.jobId === input.targetDeploymentId && t.teamLoginKey === input.teamLoginKey,
  );
  if (!target) return { kind: "not_found" };

  if (target.status !== "COMPLETE") return { kind: "not_ready" };

  const provider = normalizeProvider(target.runtimeProvider);
  const descriptor: TargetAccessDescriptor = {
    targetId: target.targetId,
    targetDeploymentId: target.jobId,
    provider,
    capability: resolveTargetAccessCapability(provider, target.status),
  };
  return { kind: "ok", descriptor };
}
