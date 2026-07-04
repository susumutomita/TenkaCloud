import {
  type CloudActionIntent,
  INTENT_VERSION,
  parseCloudActionIntent,
  type SignOptions,
  signIntent,
} from "@TenkaCloud/trust-bridge";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ISSUER (control-plane sign-side).
 *
 * The symmetric counterpart to the ingress verify-side (`orchestrator.ts`). This is
 * the code half of the "Workers-side intent issuance": it builds a `CloudActionIntent`
 * from typed deploy/destroy parameters, validates it against the SAME authoritative
 * `CloudActionIntentSchema` the ingress verifies against, signs it with the shared
 * JWS signer, and produces the EXACT POST body shape the ingress accepts.
 *
 * Design constraints that keep the sign↔verify binding provable:
 *   - Every field is validated through `parseCloudActionIntent` (the schema's safe
 *     entry point). A bad parameter fails loudly (throw) — never silently coerced —
 *     so a malformed intent can never be minted and signed (AGENTS.md: no silent
 *     fallbacks).
 *   - Signing reuses `signIntent` (never a reimplemented signer), so the JWS bytes
 *     the ingress verifies are produced by the one canonical HS256 path.
 *   - The signing key is injected as `secret: Uint8Array` via `SignOptions`; this
 *     module never resolves SSM / KMS. The Workers host resolves the key and passes
 *     it in, so the issuance LOGIC stays pure and offline-testable.
 *   - `action.engine` is pinned to `cloudformation` and `target.provider` to `aws`:
 *     this issuer mints AWS-CloudFormation deploy/destroy commands, matching the
 *     frozen `DeployCreate/DeleteRequested` detail the ingress re-emits.
 */

/** Fixed AWS-CloudFormation execution engine for this issuer. */
const ISSUER_ENGINE = "cloudformation" as const;
/** Fixed target cloud provider (AWS account referenced by `providerAccountRef`). */
const ISSUER_PROVIDER = "aws" as const;

/**
 * Typed parameters for building a deploy/destroy intent. `teamId` / `eventId` /
 * `region` / `audience` are optional at the schema level, but a downstream deploy
 * detail-build needs `teamId` + `region` — omit them only when intentionally
 * minting an intent the ingress will reject at the detail-build stage.
 */
export interface BuildIntentParams {
  readonly tenantId: string;
  readonly workloadId: string;
  readonly problemId: string;
  readonly deploymentId: string;
  readonly teamId?: string;
  readonly eventId?: string;
  readonly providerAccountRef: string;
  readonly region?: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly audience?: string;
  readonly allowPrivilegeEscalation?: boolean;
  readonly requestedScopes: readonly string[];
}

/** The two mutating verbs this issuer mints (map to Create/Delete deploy events). */
type ActionType = "deploy" | "destroy";

/**
 * Assemble + validate a `CloudActionIntent`. Throws (loudly, with the schema's own
 * path-annotated issues) if any parameter violates the authoritative schema.
 */
function buildIntent(params: BuildIntentParams, actionType: ActionType): CloudActionIntent {
  const candidate = {
    version: INTENT_VERSION,
    requestId: params.requestId,
    nonce: params.nonce,
    ...(params.audience !== undefined ? { audience: params.audience } : {}),
    source: {
      system: "tenkacloud",
      tenantId: params.tenantId,
      workloadId: params.workloadId,
      problemId: params.problemId,
      deploymentId: params.deploymentId,
      ...(params.teamId !== undefined ? { teamId: params.teamId } : {}),
      ...(params.eventId !== undefined ? { eventId: params.eventId } : {}),
    },
    target: {
      provider: ISSUER_PROVIDER,
      providerAccountRef: params.providerAccountRef,
      ...(params.region !== undefined ? { region: params.region } : {}),
    },
    action: {
      type: actionType,
      engine: ISSUER_ENGINE,
      requestedScopes: params.requestedScopes,
    },
    constraints: {
      ttlSeconds: params.ttlSeconds,
      expiresAt: params.expiresAt,
      allowPrivilegeEscalation: params.allowPrivilegeEscalation ?? false,
    },
  };

  const parsed = parseCloudActionIntent(candidate);
  if (!parsed.ok) {
    throw new Error(`invalid CloudActionIntent: ${parsed.issues.join("; ")}`);
  }
  return parsed.intent;
}

/**
 * Build a validated `deploy` intent (`action.type = "deploy"`). The ingress maps
 * this to a frozen `DeployCreateRequested` event.
 */
export function buildDeployIntent(params: BuildIntentParams): CloudActionIntent {
  return buildIntent(params, "deploy");
}

/**
 * Build a validated `destroy` intent (`action.type = "destroy"`). The ingress maps
 * this to a frozen `DeployDeleteRequested` event.
 */
export function buildDestroyIntent(params: BuildIntentParams): CloudActionIntent {
  return buildIntent(params, "destroy");
}

/**
 * Wrap a compact JWS token in the exact envelope the ingress orchestrator parses:
 * `JSON.parse(rawBody)` → `z.object({ token }).strict()`. Any other shape is rejected
 * by the ingress as `malformed-request-body`, so this is the single source of truth
 * for the POST body.
 */
export function buildIntentRequestBody(token: string): string {
  return JSON.stringify({ token });
}

/**
 * Sign a validated intent and return both the compact JWS token and the ready-to-POST
 * request body. Signing is delegated to `signIntent`; the key is injected via
 * `SignOptions.secret` (this module never reads SSM/KMS).
 */
export function issueSignedIntentRequest(
  intent: CloudActionIntent,
  signOptions: SignOptions,
): { readonly token: string; readonly body: string } {
  const token = signIntent(intent, signOptions);
  return { token, body: buildIntentRequestBody(token) };
}
