import type {
  IntentVerifyFailureReason,
  IntentVerifyOutcome,
  VerifiedCloudActionIntent,
} from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { type DeployDetailType, mapActionToDetailType } from "./action-map.js";
import { buildDeployCreateDetail, buildDeployDeleteDetail } from "./detail-builder.js";
import type { IntentScopeVerdict } from "./scope-authorization.js";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ingress transport orchestrator.
 *
 * The offline-testable core of the ingress Lambda. It receives the raw request
 * body, verifies the JWS-signed `CloudActionIntent`, authorizes its scope, maps
 * the action to a FROZEN deploy detail-type, builds the frozen detail, and
 * re-emits it onto the existing EventBridge deploy bus — so every downstream
 * state machine is untouched. All I/O (JWS secret resolution, nonce store,
 * EventBridge publish) is injected, so the whole flow runs in-memory in tests.
 *
 * The response body only ever carries STABLE reason codes (never raw error text
 * or secrets); verification failures collapse to a coarse `intent-unauthorized`
 * so the endpoint is not a signature-vs-secret oracle.
 */

/** Request envelope: the compact JWS token carrying the signed intent. */
export const IngressRequestSchema = z.object({ token: z.string().min(1) }).strict();

export interface IntentIngressDeps {
  /** JWS + schema + TTL + replay verification (bind `verifyIntent` with secret/nonce/now here). */
  readonly verify: (token: string) => Promise<IntentVerifyOutcome>;
  /** Platform-local scope gate (bind `authorizeIntentScope` with the env config here). */
  readonly authorizeScope: (intent: VerifiedCloudActionIntent) => IntentScopeVerdict;
  /** problemId → problemDir; mirrors the deploy handler's `problemsCatalog[problemId]`. */
  readonly resolveProblemDir: (problemId: string) => string | undefined;
  /** Resolve only a verified tenant-owned competitor account; null rejects the intent. */
  readonly resolveVerifiedAccount: (
    tenantId: string,
    awsAccountId: string,
  ) => Promise<{
    readonly competitorRoleArn: string;
    readonly externalIdParameterName: string;
  } | null>;
  /** Re-emit onto the existing deploy bus (bind `publishProblemEvent` with client/bus here). */
  readonly publish: (
    detailType: DeployDetailType,
    jobId: string,
    detail: Record<string, unknown>,
  ) => Promise<void>;
}

export interface IntentIngressResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Map a verification failure to a status + a coarse, non-oracle stable reason code. */
function verifyFailureResponse(reason: IntentVerifyFailureReason): IntentIngressResponse {
  switch (reason) {
    case "schema-invalid":
      return { status: StatusCodes.BAD_REQUEST, body: { reason: "intent-schema-invalid" } };
    case "nonce-replay":
      return { status: StatusCodes.CONFLICT, body: { reason: "nonce-replay" } };
    case "jws-malformed":
    case "jws-unknown-algorithm":
    case "jws-secret-not-resolved":
    case "jws-signature-mismatch":
    case "jws-payload-parse-failed":
    case "not-yet-valid":
    case "expired":
      return { status: StatusCodes.UNAUTHORIZED, body: { reason: "intent-unauthorized" } };
  }
}

/**
 * Verify → authorize → map → build → re-emit. Returns a `{ status, body }` pair;
 * the Lambda adapter shapes it into a Function URL / API Gateway response.
 */
export async function handleIntentIngress(
  rawBody: string,
  deps: IntentIngressDeps,
): Promise<IntentIngressResponse> {
  // 1. Envelope: must be JSON with a non-empty `token`.
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: StatusCodes.BAD_REQUEST, body: { reason: "malformed-request-body" } };
  }
  const envelope = IngressRequestSchema.safeParse(json);
  if (!envelope.success) {
    return { status: StatusCodes.BAD_REQUEST, body: { reason: "malformed-request-body" } };
  }

  // 2. Authenticity: JWS signature + schema + TTL/notBefore + nonce replay.
  const verified = await deps.verify(envelope.data.token);
  if (!verified.ok) {
    return verifyFailureResponse(verified.reason);
  }
  const intent = verified.intent;

  // 3. Authorization: a valid signature is NOT authorization.
  const scope = deps.authorizeScope(intent);
  if (!scope.ok) {
    return { status: StatusCodes.FORBIDDEN, body: { reason: scope.reason } };
  }

  // 4. Action → frozen detail-type. Non-deploy verbs have no deploy-bus detail-type.
  const mapping = mapActionToDetailType(intent.action.type);
  if (!mapping.ok) {
    return { status: StatusCodes.UNPROCESSABLE_ENTITY, body: { reason: mapping.reason } };
  }

  // 5. Resolve the tenant-owned deployment account. Both deploy and destroy must carry
  // the role + ExternalId parameter pair so downstream execution cannot fall back to
  // same-account credentials.
  const resolvedAccount = await deps.resolveVerifiedAccount(
    intent.source.tenantId,
    intent.target.providerAccountRef,
  );
  if (resolvedAccount === null) {
    return {
      status: StatusCodes.FORBIDDEN,
      body: { reason: "account-not-verified" },
    };
  }

  // 6. Build the FROZEN detail (fails closed on missing identifiers / bad shape).
  const built =
    mapping.detailType === "DeployCreateRequested"
      ? buildDeployCreateDetail(
          intent,
          { resolveProblemDir: deps.resolveProblemDir },
          resolvedAccount,
        )
      : buildDeployDeleteDetail(intent, resolvedAccount);
  if (!built.ok) {
    return { status: StatusCodes.UNPROCESSABLE_ENTITY, body: { reason: built.reason } };
  }

  // 7. Re-emit onto the existing deploy bus. A publish failure is a loud 5xx with a
  // stable code — never the raw EventBridge error message.
  try {
    await deps.publish(mapping.detailType, built.detail.jobId, built.detail);
  } catch {
    return {
      status: StatusCodes.INTERNAL_SERVER_ERROR,
      body: { reason: "event-publish-failed" },
    };
  }

  return { status: StatusCodes.ACCEPTED, body: { requestId: intent.requestId } };
}
