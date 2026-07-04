import {
  type BuildIntentParams,
  buildDeployIntent,
  buildDestroyIntent,
  issueSignedIntentRequest,
} from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";

/**
 * ADR-049 Phase 4 (Issue #2293) — Workers-side signed-intent issuance.
 *
 * Turns an organizer's deploy/destroy command into a JWS-signed `CloudActionIntent`
 * and POSTs it to the AWS intent-ingress Function URL. The intent carries only
 * identifiers — never `ExternalId` or other cross-account secrets; the AWS side
 * resolves those from SSM. The signing key is the Workers secret
 * `INTENT_SIGNING_SECRET` and must hold the same value as the SSM SecureString the
 * ingress verifies with (trust-bridge JWS is HS256 in Phase 1).
 */

/** Validity window for a minted intent; the ingress rejects anything older. */
export const INTENT_TTL_SECONDS = 300;

/** The workload identity claimed in `source.workloadId` for intents minted here. */
export const INTENT_WORKLOAD_ID = "always-on-control-plane";

export type DeployIntentAction = "deploy" | "destroy";

/** CloudFormation scopes requested per action; the AWS side enforces actual IAM. */
const ACTION_SCOPES: Record<DeployIntentAction, readonly string[]> = {
  deploy: ["cloudformation:CreateStack"],
  destroy: ["cloudformation:DeleteStack"],
};

export interface DeployIntentCommand {
  readonly action: DeployIntentAction;
  readonly tenantId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly awsAccountId: string;
  readonly region: string;
}

export interface IntentGateway {
  readonly ingressUrl: string;
  readonly audience?: string;
  readonly signingSecret: Uint8Array;
  readonly fetchImpl: typeof fetch;
}

export type DeployIntentOutcome =
  | { readonly accepted: true; readonly requestId: string }
  | { readonly accepted: false; readonly ingressStatus: number; readonly reason: string };

/** Bindings consumed here; `INTENT_SIGNING_SECRET` is a Workers secret, not a var. */
export interface IntentEnvironment {
  readonly INTENT_INGRESS_URL?: string;
  readonly INTENT_AUDIENCE?: string;
  readonly INTENT_SIGNING_SECRET?: string;
}

function requiredBinding(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function intentGatewayFromEnvironment(
  environment: IntentEnvironment,
  fetchImpl: typeof fetch,
): IntentGateway {
  const ingressUrl = requiredBinding(environment.INTENT_INGRESS_URL, "INTENT_INGRESS_URL");
  const secret = requiredBinding(environment.INTENT_SIGNING_SECRET, "INTENT_SIGNING_SECRET");
  const audience = environment.INTENT_AUDIENCE;
  return {
    ingressUrl,
    ...(audience ? { audience } : {}),
    signingSecret: new TextEncoder().encode(secret),
    fetchImpl,
  };
}

/** The ingress replies with stable `{ reason }` codes; anything else collapses to one code. */
async function ingressReason(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { reason?: unknown }).reason === "string"
    ) {
      return (parsed as { reason: string }).reason;
    }
  } catch {
    // Non-JSON ingress responses fall through to the stable fallback code.
  }
  return "ingress-rejected";
}

/**
 * Mint, sign, and POST one deploy/destroy intent. `deploymentId` is pinned to the
 * minted `requestId`, so the jobId the ingress derives equals the requestId returned
 * to the organizer — one identity across both planes.
 */
export async function issueDeployIntentCommand(
  command: DeployIntentCommand,
  gateway: IntentGateway,
): Promise<DeployIntentOutcome> {
  const requestId = crypto.randomUUID();
  const params: BuildIntentParams = {
    tenantId: command.tenantId,
    workloadId: INTENT_WORKLOAD_ID,
    problemId: command.problemId,
    deploymentId: requestId,
    teamId: command.teamId,
    eventId: command.eventId,
    providerAccountRef: command.awsAccountId,
    region: command.region,
    requestId,
    nonce: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + INTENT_TTL_SECONDS * 1000).toISOString(),
    ttlSeconds: INTENT_TTL_SECONDS,
    ...(gateway.audience === undefined ? {} : { audience: gateway.audience }),
    requestedScopes: ACTION_SCOPES[command.action],
  };
  const intent =
    command.action === "deploy" ? buildDeployIntent(params) : buildDestroyIntent(params);
  const { body } = issueSignedIntentRequest(intent, { secret: gateway.signingSecret });

  const response = await gateway.fetchImpl(gateway.ingressUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (response.status === StatusCodes.ACCEPTED) {
    return { accepted: true, requestId };
  }
  return {
    accepted: false,
    ingressStatus: response.status,
    reason: await ingressReason(response),
  };
}
