import { AwsClient } from "aws4fetch";
import { base64UrlEncode } from "./crypto.js";
import { type OidcEnvironment, signingKeyFromEnvironment } from "./oidc.js";

/**
 * Issue #2555: OIDC command transport.
 *
 * Replaces the bespoke signed-intent POST: the Worker mints a short-TTL ES256
 * JWT against its own OIDC IdP surface, exchanges it for scoped, minutes-lived
 * credentials via `sts:AssumeRoleWithWebIdentity`, and publishes the frozen
 * `tenkacloud.deploy` EventBridge event
 * itself. AWS verifies the token against the Worker's JWKS; there is no
 * project-side verifier. `AssumeRoleWithWebIdentity` is an unsigned STS call;
 * only `PutEvents` needs SigV4 (aws4fetch).
 */

/** A command token is valid for five minutes to bound replay. */
export const COMMAND_TOKEN_TTL_SECONDS = 300;

/** Subject prefix enforced by the command role's trust policy. */
export const COMMAND_SUBJECT_PREFIX = "tenkacloud:always-on:command:";

/** The one audience STS accepts for web-identity federation. */
export const STS_AUDIENCE = "sts.amazonaws.com";

/** Web-identity session length: the 15-minute STS minimum. */
const SESSION_DURATION_SECONDS = 900;

/** Frozen EventBridge source consumed by the deploy handler. */
export const DEPLOY_EVENT_SOURCE = "tenkacloud.deploy";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export interface MintCommandTokenInput {
  readonly environment: OidcEnvironment;
  /** Issuer — the Worker origin serving the discovery document (no trailing slash). */
  readonly issuer: string;
  readonly tenantId: string;
  readonly eventId: string;
  /** Epoch milliseconds "now"; injectable for tests. */
  readonly nowMs?: number;
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Mint the short-TTL OIDC JWT the command role's trust policy accepts:
 * `iss` = the Worker origin, `aud` = STS, `sub` = the tenant/event-scoped
 * command subject, `kid` = the JWKS key id (thumbprint unless pinned).
 */
export async function mintCommandToken(input: MintCommandTokenInput): Promise<string> {
  const { privateJwk, publicJwk } = await signingKeyFromEnvironment(input.environment);
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: publicJwk.kid };
  const payload = {
    iss: input.issuer,
    sub: `${COMMAND_SUBJECT_PREFIX}${input.tenantId}:${input.eventId}`,
    aud: STS_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + COMMAND_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export type StsExchangeOutcome =
  | { readonly ok: true; readonly credentials: AwsCredentials }
  | { readonly ok: false; readonly status?: number };

interface StsJsonResponse {
  readonly AssumeRoleWithWebIdentityResponse?: {
    readonly AssumeRoleWithWebIdentityResult?: {
      readonly Credentials?: {
        readonly AccessKeyId?: string;
        readonly SecretAccessKey?: string;
        readonly SessionToken?: string;
      };
    };
  };
}

export interface AssumeCommandRoleInput {
  readonly token: string;
  readonly roleArn: string;
  readonly region: string;
  /** STS session name, surfaced in CloudTrail ([\w+=,.@-]{2,64}). */
  readonly sessionName: string;
  readonly fetchImpl: typeof fetch;
}

/**
 * Exchange the minted token for scoped, short-lived credentials. The call is
 * unsigned (the token IS the credential); a non-2xx response — e.g. a trust
 * policy mismatch — is a platform misconfiguration surfaced as a gateway
 * failure, never retried with different parameters.
 */
export async function assumeCommandRole(
  input: AssumeCommandRoleInput,
): Promise<StsExchangeOutcome> {
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: input.roleArn,
    RoleSessionName: input.sessionName,
    WebIdentityToken: input.token,
    DurationSeconds: String(SESSION_DURATION_SECONDS),
  });
  let response: Response;
  try {
    response = await input.fetchImpl(`https://sts.${input.region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  let parsed: StsJsonResponse;
  try {
    parsed = (await response.json()) as StsJsonResponse;
  } catch {
    return { ok: false, status: response.status };
  }
  const credentials =
    parsed.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
  if (
    typeof credentials?.AccessKeyId !== "string" ||
    typeof credentials.SecretAccessKey !== "string" ||
    typeof credentials.SessionToken !== "string"
  ) {
    return { ok: false, status: response.status };
  }
  return {
    ok: true,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  };
}

export interface PutDeployEventInput {
  readonly credentials: AwsCredentials;
  /** Region hosting the deploy bus (the platform region, not the deploy target). */
  readonly region: string;
  /** Bus ARN (PutEvents accepts the ARN as EventBusName). */
  readonly eventBusArn: string;
  readonly detailType: "DeployCreateRequested" | "DeployDeleteRequested";
  readonly jobId: string;
  readonly detail: Record<string, unknown>;
  readonly fetchImpl: typeof fetch;
}

export type PutEventsOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status?: number };

interface PutEventsResponseBody {
  readonly FailedEntryCount?: number;
}

/**
 * Publish one frozen deploy event with the federated credentials. Mirrors the
 * platform's `publishProblemEvent` entry shape (Source / DetailType / Detail /
 * Resources `tenkacloud:deployment:<jobId>`), so downstream subscribers see an
 * identical event regardless of which seam published it.
 */
export async function putDeployEvent(input: PutDeployEventInput): Promise<PutEventsOutcome> {
  const client = new AwsClient({
    accessKeyId: input.credentials.accessKeyId,
    secretAccessKey: input.credentials.secretAccessKey,
    sessionToken: input.credentials.sessionToken,
    region: input.region,
    service: "events",
  });
  const signed = await client.sign(`https://events.${input.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSEvents.PutEvents",
    },
    body: JSON.stringify({
      Entries: [
        {
          Source: DEPLOY_EVENT_SOURCE,
          DetailType: input.detailType,
          Detail: JSON.stringify(input.detail),
          EventBusName: input.eventBusArn,
          Resources: [`tenkacloud:deployment:${input.jobId}`],
        },
      ],
    }),
  });
  let response: Response;
  try {
    response = await input.fetchImpl(signed);
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  let parsed: PutEventsResponseBody;
  try {
    parsed = (await response.json()) as PutEventsResponseBody;
  } catch {
    return { ok: false, status: response.status };
  }
  if (parsed.FailedEntryCount !== undefined && parsed.FailedEntryCount > 0) {
    return { ok: false, status: response.status };
  }
  return { ok: true };
}
