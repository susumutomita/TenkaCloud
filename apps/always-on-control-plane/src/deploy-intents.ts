import {
  type BuildIntentParams,
  buildDeployIntent,
  buildDestroyIntent,
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_PROBLEM_ID_PATTERN,
  issueSignedIntentRequest,
} from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

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

/**
 * Organizer command body. Identifier shapes mirror the frozen deploy detail
 * schema (via the trust-bridge patterns), so a command the ingress would reject
 * fails fast before a signature + nonce is spent. `deploymentId` is the identity
 * a deploy 202 returned; a destroy MUST reference it so the downstream jobId
 * matches the deployment row being destroyed (a deploy must not supply one —
 * the Worker mints it).
 */
export const DeployIntentCommandInputSchema = z
  .object({
    action: z.enum(["deploy", "destroy"]),
    teamId: z.string().min(1),
    problemId: z.string().regex(DEPLOY_PROBLEM_ID_PATTERN, "must be a lowercase problem slug"),
    awsAccountId: z
      .string()
      .regex(DEPLOY_AWS_ACCOUNT_ID_PATTERN, "must be a 12-digit AWS account id"),
    region: z.string().regex(DEPLOY_AWS_REGION_PATTERN, "must be an AWS region name"),
    deploymentId: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "deploy" && input.deploymentId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deploymentId"],
        message: "must be omitted for deploy commands (the Worker mints it)",
      });
    }
    if (input.action === "destroy" && input.deploymentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deploymentId"],
        message: "destroy requires the deploymentId returned by the original deploy",
      });
    }
  });

export type DeployIntentCommandInput = z.infer<typeof DeployIntentCommandInputSchema>;
export type DeployIntentAction = DeployIntentCommandInput["action"];

/** CloudFormation scopes requested per action; the AWS side enforces actual IAM. */
const ACTION_SCOPES: Record<DeployIntentAction, readonly string[]> = {
  deploy: ["cloudformation:CreateStack"],
  destroy: ["cloudformation:DeleteStack"],
};

export type DeployIntentCommand = DeployIntentCommandInput & {
  readonly tenantId: string;
  readonly eventId: string;
};

export interface IntentGateway {
  readonly ingressUrl: string;
  readonly audience?: string;
  readonly signingSecret: Uint8Array;
  readonly fetchImpl: typeof fetch;
}

export type DeployIntentOutcome =
  | { readonly accepted: true; readonly requestId: string; readonly deploymentId: string }
  | { readonly accepted: false; readonly ingressStatus?: number; readonly reason: string };

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
 * Mint, sign, and POST one deploy/destroy intent. For a deploy, `deploymentId`
 * is pinned to the minted `requestId`, so the jobId the ingress derives equals
 * the requestId returned to the organizer. For a destroy, the caller-supplied
 * `deploymentId` (from the original deploy 202) is carried instead, so the
 * downstream delete marks the SAME deployment row — never a fresh phantom id.
 */
export async function issueDeployIntentCommand(
  command: DeployIntentCommand,
  gateway: IntentGateway,
): Promise<DeployIntentOutcome> {
  const requestId = crypto.randomUUID();
  const deploymentId = command.deploymentId ?? requestId;
  const params: BuildIntentParams = {
    tenantId: command.tenantId,
    workloadId: INTENT_WORKLOAD_ID,
    problemId: command.problemId,
    deploymentId,
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

  let response: Response;
  try {
    response = await gateway.fetchImpl(gateway.ingressUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "always-on.deploy-intent.ingress-unreachable",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return { accepted: false, reason: "ingress-unreachable" };
  }
  if (response.status === StatusCodes.ACCEPTED) {
    return { accepted: true, requestId, deploymentId };
  }
  return {
    accepted: false,
    ingressStatus: response.status,
    reason: await ingressReason(response),
  };
}
