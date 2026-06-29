/**
 * [Composite Runtime / Issue #2077] Bridge a ready composite AWS target to the
 * EXISTING participant AWS Console federation + CLI credential issuance.
 *
 * This is a thin, additive delegation layer — NOT a second SSO system. It:
 *   1. resolves the target server-side, team-scoped, via the #2076 contract
 *      ({@link lookupTargetAccess} over the #2061 repository / GSI3),
 *   2. verifies the resolved provider is `aws` and the capability matrix grants
 *      `console` / `cli-credentials` (a non-AWS / unsupported target is rejected
 *      as a capability mismatch and STS is NEVER reached),
 *   3. re-reads the full COMPLETE target row server-side and hands it to the
 *      proven {@link getConsoleSigninUrl} / {@link getCliCredentials} functions
 *      through an injected loader, so the existing validation, two-stage
 *      AssumeRole (CompetitorDeployRole → ParticipantViewerRole), federation,
 *      session duration, and audit fields all run unchanged.
 *
 * Security invariants (issue #2077):
 *   - A participant cannot reach another team's / tenant's target: the lookup
 *     keys on the authenticated `teamLoginKey`, so a cross-team target is
 *     `not_found` (indistinguishable from missing).
 *   - The API never accepts a role ARN, account id, or `targetDeploymentId` from
 *     the client as an authority. The `(parentDeploymentId, targetDeploymentId)`
 *     pair is consumed ONLY as a lookup key; every credential-bearing field
 *     (competitorRoleArn / ParticipantViewerRoleArn / region / namePrefix /
 *     ExternalId) is read from the resolved row.
 *   - One-time / short-lived credential behavior is inherited unchanged from the
 *     delegated functions; this module adds no credential storage.
 *
 * Composite target rows deliberately do NOT populate GSI2 (the participant
 * teamLoginKey query the legacy SSO path uses), so the bridge cannot simply call
 * the legacy function with the team key — it injects a loader returning the
 * GSI3-resolved row instead. Legacy single-provider deployments never route here
 * and keep their existing `/portal/me/console-signin-url` + `/cli-credentials`
 * contract untouched.
 */

import type { CompositeDeploymentRepositoryDeps } from "../deploy-handler/composite-repository.js";
import { getCompositeTarget } from "../deploy-handler/composite-repository.js";
import {
  lookupTargetAccess,
  type TargetAccessProvider,
} from "../deploy-handler/composite-target-access.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import type { ParticipantSharedResources } from "./shared.js";
import {
  type CliCredentialsOutcome,
  getCliCredentials,
  getConsoleSigninUrl,
  type SsoOutcome,
} from "./sso.js";

/**
 * Injected collaborators. `repo` drives the team-scoped GSI3 lookup; the two
 * delegates default to the real participant Console / CLI functions but are
 * overridable so tests run without real AWS STS.
 */
export interface CompositeAwsAccessBridgeDeps {
  readonly repo: CompositeDeploymentRepositoryDeps;
  readonly consoleSignin?: typeof getConsoleSigninUrl;
  readonly cliCredentials?: typeof getCliCredentials;
}

/**
 * Lookup key for a composite-target access request. Both ids are consumed ONLY
 * to locate the team-scoped row — never as an authority. `teamLoginKey` is the
 * authenticated participant team (the access boundary).
 */
export interface CompositeAwsAccessInput {
  readonly teamLoginKey: string;
  readonly parentDeploymentId: string;
  readonly targetDeploymentId: string;
}

/** A non-AWS / unsupported target rejected before any STS call. */
export interface CapabilityMismatchOutcome {
  readonly kind: "capability_mismatch";
  readonly provider: TargetAccessProvider;
}

export type CompositeConsoleSigninOutcome =
  | SsoOutcome
  | { kind: "not_found" }
  | CapabilityMismatchOutcome;

export type CompositeCliCredentialsOutcome =
  | CliCredentialsOutcome
  | { kind: "not_found" }
  | CapabilityMismatchOutcome;

/**
 * Resolve the target to a verified AWS, COMPLETE descriptor — or a typed
 * rejection. Centralizes the security gate both delegations share:
 *   - `not_found`           — missing OR another team's target (indistinguishable),
 *   - `not_ready`           — the target exists for the team but is not COMPLETE,
 *   - `capability_mismatch` — a COMPLETE non-AWS / unsupported target (no STS).
 *
 * On success it returns the resolved `targetDeploymentId` (from the row, NEVER
 * echoing the client value as authority — they are equal only because the lookup
 * matched the row to it).
 */
type ResolveAwsTargetOutcome =
  | { kind: "aws"; targetDeploymentId: string }
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | CapabilityMismatchOutcome;

async function resolveAwsTarget(
  deps: CompositeAwsAccessBridgeDeps,
  input: CompositeAwsAccessInput,
): Promise<ResolveAwsTargetOutcome> {
  const outcome = await lookupTargetAccess(deps.repo, {
    teamLoginKey: input.teamLoginKey,
    parentDeploymentId: input.parentDeploymentId,
    targetDeploymentId: input.targetDeploymentId,
  });

  if (outcome.kind === "not_found") return { kind: "not_found" };
  if (outcome.kind === "not_ready") return { kind: "not_ready" };

  // Only an `aws` target with the console + cli-credentials capability may reach
  // the existing AWS sign-in path. Anything else (gcp / azure / sakura →
  // external-portal, or an unsupported provider) is a capability mismatch — STS
  // is never invoked for it.
  if (outcome.descriptor.provider !== "aws" || !outcome.descriptor.capability.includes("console")) {
    return { kind: "capability_mismatch", provider: outcome.descriptor.provider };
  }

  return { kind: "aws", targetDeploymentId: outcome.descriptor.targetDeploymentId };
}

/**
 * Build the injected SSO loader that returns the server-resolved composite
 * target row for the resolved `(teamLoginKey, targetDeploymentId)`. The legacy
 * GSI2 team query cannot see composite targets, so the delegate must read the
 * base-table row by the server-resolved id instead. The loader re-validates the
 * row still belongs to the authenticated team and parent before returning it, so
 * a row that changed ownership between lookup and load is not served.
 */
function buildTargetLoader(deps: CompositeAwsAccessBridgeDeps, input: CompositeAwsAccessInput) {
  return async (
    _shared: ParticipantSharedResources,
    teamLoginKey: string,
    jobId: string,
  ): Promise<Partial<DeploymentItem> | undefined> => {
    const target = await getCompositeTarget(deps.repo, jobId);
    if (
      !target ||
      target.parentDeploymentId !== input.parentDeploymentId ||
      target.teamLoginKey !== teamLoginKey
    ) {
      return undefined;
    }
    // A composite target row is structurally a deployment row (Omit<DeploymentItem,
    // GSI1/GSI2 keys> + composite linkage), so it satisfies the SSO loader's
    // Partial<DeploymentItem> contract directly.
    return target as Partial<DeploymentItem>;
  };
}

/**
 * Bridge a ready composite AWS target to the existing AWS Console one-click
 * sign-in URL. Delegates to {@link getConsoleSigninUrl} with a server-resolved
 * row; rejects non-AWS / not-ready / not-found before any STS call.
 */
export async function bridgeCompositeConsoleSignin(
  shared: ParticipantSharedResources,
  deps: CompositeAwsAccessBridgeDeps,
  input: CompositeAwsAccessInput,
): Promise<CompositeConsoleSigninOutcome> {
  const resolved = await resolveAwsTarget(deps, input);
  if (resolved.kind !== "aws") return resolved;

  const signin = deps.consoleSignin ?? getConsoleSigninUrl;
  return signin(shared, input.teamLoginKey, resolved.targetDeploymentId, {
    loadDeployment: buildTargetLoader(deps, input),
  });
}

/**
 * Bridge a ready composite AWS target to the existing short-lived AWS CLI / SDK
 * credentials. Delegates to {@link getCliCredentials} with a server-resolved
 * row; rejects non-AWS / not-ready / not-found before any STS call.
 */
export async function bridgeCompositeCliCredentials(
  shared: ParticipantSharedResources,
  deps: CompositeAwsAccessBridgeDeps,
  input: CompositeAwsAccessInput,
): Promise<CompositeCliCredentialsOutcome> {
  const resolved = await resolveAwsTarget(deps, input);
  if (resolved.kind !== "aws") return resolved;

  const cli = deps.cliCredentials ?? getCliCredentials;
  return cli(shared, input.teamLoginKey, resolved.targetDeploymentId, {
    loadDeployment: buildTargetLoader(deps, input),
  });
}
