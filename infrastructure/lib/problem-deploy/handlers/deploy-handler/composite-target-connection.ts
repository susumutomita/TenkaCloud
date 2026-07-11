/**
 * [Composite Runtime / Issue #2065] Provider-neutral target connection resolver.
 *
 * Used ONLY by future Composite deployment code to decide whether a single
 * target (aws / gcp / azure / sakura) has a usable per-team connection — without
 * forcing every target through the AWS competitor-account gate. Existing
 * single-provider `startDeployment` behaviour is untouched (it keeps its own AWS
 * verified-account gate).
 *
 * This is a pre-flight existence check only. It performs NO token exchange, role
 * assumption, or provider API call, and it returns NO secret / token /
 * credential:
 *   - AWS  → the existing verified competitor-account lookup; a missing /
 *     unverified account throws the existing {@link UnverifiedCompetitorAccountError}.
 *     The returned ARN + SSM parameter *name* are identifiers, not secrets.
 *   - GCP / Azure / Sakura → the existing per-team SecureString config store is
 *     read for structural validity (via its fail-closed parser); only the
 *     `teamSlug` is returned, never the stored config (which may hold an Azure
 *     client secret or a Sakura API key).
 */

import { getAzureCredential } from "../shared/azure-credential-store.js";
import {
  type CompetitorAccountResolveDeps,
  resolveVerifiedCompetitorAccount,
} from "../shared/competitor-account-lookup.js";
import { getGcpCredential } from "../shared/gcp-credential-store.js";
import type { ReservedProvider } from "../shared/runtime/index.js";
import { getSakuraCredential } from "../shared/sakura-credential-store.js";
import type { SecureJsonStoreDeps } from "../shared/secure-json-store.js";
import { UnverifiedCompetitorAccountError } from "./deploy.js";

/** A resolved, secret-free connection for one composite target. */
export type TargetConnection =
  | {
      readonly provider: "aws";
      readonly awsAccountId: string;
      readonly region: string;
      readonly competitorRoleArn: string;
      readonly externalIdParameterName?: string;
    }
  | { readonly provider: "gcp"; readonly teamSlug: string }
  | { readonly provider: "azure"; readonly teamSlug: string }
  | { readonly provider: "sakura"; readonly teamSlug: string };

/**
 * [Issue #2562] Derived from `@tenkacloud/problem-runtime`'s `RESERVED_RUNTIMES`
 * (the single source of truth for the non-AWS provider set) instead of a
 * hand-written literal union — this file previously listed `"gcp" | "azure" |
 * "sakura"` independently, which could silently drift from the frontend's own
 * derived `NON_AWS_SELECTABLE_PROVIDERS` (`apps/application-admin-console/src/data/problem-mapping.ts`).
 */
type NonAwsProvider = ReservedProvider;

/** Raised when a non-AWS target has no valid per-team connection configured. */
export class MissingTargetConnectionError extends Error {
  constructor(
    public readonly provider: NonAwsProvider,
    public readonly tenantId: string,
    public readonly teamSlug: string,
  ) {
    super(`no valid ${provider} connection for team ${teamSlug} in tenant ${tenantId}`);
    this.name = "MissingTargetConnectionError";
  }
}

/** Injected dependencies. The clients are created by the caller, not here. */
export interface CompositeTargetConnectionDeps {
  /** Deps for the AWS verified competitor-account lookup. */
  readonly aws: CompetitorAccountResolveDeps;
  /** Deps for the per-team GCP / Azure / Sakura SSM SecureString stores. */
  readonly credentials: SecureJsonStoreDeps;
}

export type ResolveCompositeTargetConnectionInput =
  | {
      readonly provider: "aws";
      readonly tenantId: string;
      readonly awsAccountId: string;
      readonly region: string;
    }
  | { readonly provider: NonAwsProvider; readonly tenantId: string; readonly teamSlug: string };

/** Existing per-team config getters, keyed by provider; all fail-closed to undefined. */
const NON_AWS_CONFIG_GETTERS: Record<
  NonAwsProvider,
  (deps: SecureJsonStoreDeps, tenantId: string, teamSlug: string) => Promise<unknown>
> = {
  gcp: getGcpCredential,
  azure: getAzureCredential,
  sakura: getSakuraCredential,
};

function nonAwsConnection(provider: NonAwsProvider, teamSlug: string): TargetConnection {
  // Per-provider literal so the result narrows to a single union member (no cast).
  switch (provider) {
    case "gcp":
      return { provider: "gcp", teamSlug };
    case "azure":
      return { provider: "azure", teamSlug };
    case "sakura":
      return { provider: "sakura", teamSlug };
  }
}

/**
 * Resolve whether a composite target can start, returning a secret-free
 * {@link TargetConnection}. Throws before any cloud mutation when the connection
 * is missing / unverified (AWS) or absent / malformed (gcp / azure / sakura).
 */
export async function resolveCompositeTargetConnection(
  deps: CompositeTargetConnectionDeps,
  input: ResolveCompositeTargetConnectionInput,
): Promise<TargetConnection> {
  if (input.provider === "aws") {
    const verified = await resolveVerifiedCompetitorAccount(
      deps.aws,
      input.tenantId,
      input.awsAccountId,
    );
    if (!verified) throw new UnverifiedCompetitorAccountError(input.awsAccountId);
    return {
      provider: "aws",
      awsAccountId: verified.awsAccountId,
      region: input.region,
      competitorRoleArn: verified.competitorRoleArn,
      externalIdParameterName: verified.externalIdParameterName,
    };
  }

  const config = await NON_AWS_CONFIG_GETTERS[input.provider](
    deps.credentials,
    input.tenantId,
    input.teamSlug,
  );
  if (config === undefined) {
    throw new MissingTargetConnectionError(input.provider, input.tenantId, input.teamSlug);
  }
  return nonAwsConnection(input.provider, input.teamSlug);
}
