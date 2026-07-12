import { StatusCodes } from "http-status-codes";

/**
 * Fake AWS edge for the OIDC command path: captures the (unsigned) STS
 * `AssumeRoleWithWebIdentity` exchange and the SigV4-signed EventBridge
 * `PutEvents` call, and replies with configurable outcomes.
 */

export interface CapturedStsCall {
  readonly url: string;
  readonly params: URLSearchParams;
  readonly accept: string | null;
}

export interface CapturedPutEventsCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly securityToken: string | null;
  readonly target: string | null;
  readonly body: {
    readonly Entries: readonly Record<string, unknown>[];
  };
}

export interface FakeAwsOptions {
  readonly stsStatus?: number;
  readonly putEventsStatus?: number;
  readonly failedEntryCount?: number;
}

export const FAKE_CREDENTIALS = {
  AccessKeyId: "ASIAFAKEACCESSKEYID",
  SecretAccessKey: "fake-secret-access-key",
  SessionToken: "fake-session-token",
} as const;

export function fakeAwsFetch(options: FakeAwsOptions = {}) {
  const stsCalls: CapturedStsCall[] = [];
  const putEventsCalls: CapturedPutEventsCall[] = [];

  // workerd warns on .text() for non-text content types; decode bytes instead.
  const bodyText = async (request: Request) =>
    new TextDecoder().decode(await request.arrayBuffer());

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname.startsWith("sts.")) {
      stsCalls.push({
        url: request.url,
        params: new URLSearchParams(await bodyText(request)),
        accept: request.headers.get("accept"),
      });
      const status = options.stsStatus ?? StatusCodes.OK;
      if (status !== StatusCodes.OK) {
        return new Response(JSON.stringify({ Error: { Code: "AccessDenied" } }), { status });
      }
      return Response.json({
        AssumeRoleWithWebIdentityResponse: {
          AssumeRoleWithWebIdentityResult: { Credentials: FAKE_CREDENTIALS },
        },
      });
    }
    if (url.hostname.startsWith("events.")) {
      putEventsCalls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        securityToken: request.headers.get("x-amz-security-token"),
        target: request.headers.get("x-amz-target"),
        body: JSON.parse(await bodyText(request)) as CapturedPutEventsCall["body"],
      });
      const status = options.putEventsStatus ?? StatusCodes.OK;
      if (status !== StatusCodes.OK) {
        return new Response(JSON.stringify({ message: "boom" }), { status });
      }
      return Response.json({
        Entries: [{ EventId: "11111111-1111-1111-1111-111111111111" }],
        FailedEntryCount: options.failedEntryCount ?? 0,
      });
    }
    throw new Error(`unexpected fetch in test: ${request.url}`);
  }) as typeof fetch;

  return { fetchImpl, stsCalls, putEventsCalls };
}

/** Decode the payload claims of a compact JWT without verifying it (test-side). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("not a compact JWT");
  const pad = "=".repeat((4 - (payload.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(payload.replace(/-/gu, "+").replace(/_/gu, "/") + pad), (c) =>
    c.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
