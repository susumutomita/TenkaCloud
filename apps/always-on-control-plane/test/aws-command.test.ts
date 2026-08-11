import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import {
  assumeCommandRole,
  COMMAND_TOKEN_TTL_SECONDS,
  mintCommandToken,
  putDeployEvent,
} from "../src/aws-command.js";
import { decodeJwtPayload, FAKE_CREDENTIALS, fakeAwsFetch } from "./helpers/aws-capture.js";

/** Same fixed P-256 vector as oidc.test.ts; KID is its RFC 7638 thumbprint. */
const PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "1eKmOOWu-FOaKedtieKvK2YrtlFl7GaMzDoAq36I07c",
  y: "LT1bJ_zI98s8BQxrpCV1MhuCO7CrO8VfLVLt5zqP4D8",
  d: "nGPyjamYMjRaOqgyKGX6uktZkAEXUb8ujIXC1JtGDX0",
};
const THUMBPRINT_KID = "Nnp5gUjUmY5woKSydtp5r2b22Pnqxk1IpNvHeozhJnw";
const ISSUER = "https://control.example";

function environmentWithKey(jwk: unknown = PRIVATE_JWK) {
  return { OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(jwk) };
}

function decodeJwtHeader(token: string): Record<string, unknown> {
  const [header] = token.split(".");
  if (!header) throw new Error("not a compact JWT");
  const pad = "=".repeat((4 - (header.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(header.replace(/-/gu, "+").replace(/_/gu, "/") + pad), (c) =>
    c.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("mintCommandToken", () => {
  it("should mint an ES256 JWT whose kid matches the served JWKS key", async () => {
    const token = await mintCommandToken({
      environment: environmentWithKey(),
      issuer: ISSUER,
      tenantId: "tenant-acme",
      eventId: "event-1",
    });
    expect(decodeJwtHeader(token)).toEqual({ alg: "ES256", typ: "JWT", kid: THUMBPRINT_KID });
  });

  it("should carry the STS audience and the tenant/event-scoped subject", async () => {
    const nowMs = 1_760_000_000_000;
    const token = await mintCommandToken({
      environment: environmentWithKey(),
      issuer: ISSUER,
      tenantId: "tenant-acme",
      eventId: "event-1",
      nowMs,
    });
    const payload = decodeJwtPayload(token);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe("sts.amazonaws.com");
    expect(payload.sub).toBe("tenkacloud:always-on:command:tenant-acme:event-1");
    expect(payload.iat).toBe(Math.floor(nowMs / 1000));
    expect(payload.exp).toBe(Math.floor(nowMs / 1000) + COMMAND_TOKEN_TTL_SECONDS);
    expect(typeof payload.jti).toBe("string");
    expect(String(payload.jti).length).toBeGreaterThan(0);
  });

  it("should sign with the private key so the served public JWK verifies it", async () => {
    const token = await mintCommandToken({
      environment: environmentWithKey(),
      issuer: ISSUER,
      tenantId: "tenant-acme",
      eventId: "event-1",
    });
    const [header, payload, signature] = token.split(".");
    const pad = "=".repeat((4 - ((signature as string).length % 4)) % 4);
    const rawSignature = Uint8Array.from(
      atob((signature as string).replace(/-/gu, "+").replace(/_/gu, "/") + pad),
      (c) => c.charCodeAt(0),
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: PRIVATE_JWK.x, y: PRIVATE_JWK.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSignature,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("should honor an explicit kid on the private JWK", async () => {
    const token = await mintCommandToken({
      environment: environmentWithKey({ ...PRIVATE_JWK, kid: "rotation-2026-07" }),
      issuer: ISSUER,
      tenantId: "t",
      eventId: "e",
    });
    expect(decodeJwtHeader(token).kid).toBe("rotation-2026-07");
  });

  it("should fail loudly when the secret lacks the private scalar d", async () => {
    const { d: _d, ...publicOnly } = PRIVATE_JWK;
    await expect(
      mintCommandToken({
        environment: environmentWithKey(publicOnly),
        issuer: ISSUER,
        tenantId: "t",
        eventId: "e",
      }),
    ).rejects.toThrow(/"d"/u);
  });
});

describe("assumeCommandRole (unsigned STS web-identity exchange)", () => {
  const INPUT = {
    roleArn: "arn:aws:iam::123456789012:role/tenkacloud-alwayson-command",
    region: "ap-northeast-1",
    sessionName: "always-on-command-test",
  };

  it("should POST the web-identity form to the regional STS endpoint and parse credentials", async () => {
    const { fetchImpl, stsCalls } = fakeAwsFetch();
    const outcome = await assumeCommandRole({ ...INPUT, token: "jwt-token", fetchImpl });
    expect(outcome).toEqual({
      ok: true,
      credentials: {
        accessKeyId: FAKE_CREDENTIALS.AccessKeyId,
        secretAccessKey: FAKE_CREDENTIALS.SecretAccessKey,
        sessionToken: FAKE_CREDENTIALS.SessionToken,
      },
    });
    expect(stsCalls).toHaveLength(1);
    expect(stsCalls[0]?.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(stsCalls[0]?.accept).toBe("application/json");
    const params = stsCalls[0]?.params;
    expect(params?.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(params?.get("Version")).toBe("2011-06-15");
    expect(params?.get("RoleArn")).toBe(INPUT.roleArn);
    expect(params?.get("RoleSessionName")).toBe(INPUT.sessionName);
    expect(params?.get("WebIdentityToken")).toBe("jwt-token");
    expect(params?.get("DurationSeconds")).toBe("900");
  });

  it("should surface a non-2xx exchange as a failure with the status", async () => {
    const { fetchImpl } = fakeAwsFetch({ stsStatus: StatusCodes.FORBIDDEN });
    const outcome = await assumeCommandRole({ ...INPUT, token: "t", fetchImpl });
    expect(outcome).toEqual({ ok: false, status: StatusCodes.FORBIDDEN });
  });

  it("should surface an unreachable STS as a failure", async () => {
    const failingFetch = (async () => {
      throw new Error("connect timeout");
    }) as unknown as typeof fetch;
    expect(await assumeCommandRole({ ...INPUT, token: "t", fetchImpl: failingFetch })).toEqual({
      ok: false,
    });
  });

  it("should fail when the response body is not JSON", async () => {
    const textFetch = (async () => new Response("<xml/>")) as unknown as typeof fetch;
    const outcome = await assumeCommandRole({ ...INPUT, token: "t", fetchImpl: textFetch });
    expect(outcome.ok).toBe(false);
  });

  it("should fail when the response carries no complete credentials", async () => {
    const partialFetch = (async () =>
      Response.json({
        AssumeRoleWithWebIdentityResponse: {
          AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "only-this" } },
        },
      })) as unknown as typeof fetch;
    const outcome = await assumeCommandRole({ ...INPUT, token: "t", fetchImpl: partialFetch });
    expect(outcome.ok).toBe(false);
  });
});

describe("putDeployEvent (SigV4-signed frozen event publish)", () => {
  const INPUT = {
    credentials: {
      accessKeyId: FAKE_CREDENTIALS.AccessKeyId,
      secretAccessKey: FAKE_CREDENTIALS.SecretAccessKey,
      sessionToken: FAKE_CREDENTIALS.SessionToken,
    },
    region: "ap-northeast-1",
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/tenkacloud-deploy",
    detailType: "DeployCreateRequested" as const,
    jobId: "job-1",
    detail: { jobId: "job-1", tenantId: "tenant-acme" },
  };

  it("should publish one frozen entry with the platform event shape, SigV4-signed", async () => {
    const { fetchImpl, putEventsCalls } = fakeAwsFetch();
    expect(await putDeployEvent({ ...INPUT, fetchImpl })).toEqual({ ok: true });
    expect(putEventsCalls).toHaveLength(1);
    const call = putEventsCalls[0];
    expect(call?.url).toBe("https://events.ap-northeast-1.amazonaws.com/");
    expect(call?.target).toBe("AWSEvents.PutEvents");
    expect(call?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAFAKEACCESSKEYID\//u);
    expect(call?.authorization).toContain("SignedHeaders=");
    expect(call?.securityToken).toBe(FAKE_CREDENTIALS.SessionToken);
    expect(call?.body.Entries).toEqual([
      {
        Source: "tenkacloud.deploy",
        DetailType: "DeployCreateRequested",
        Detail: JSON.stringify(INPUT.detail),
        EventBusName: INPUT.eventBusArn,
        Resources: ["tenkacloud:deployment:job-1"],
      },
    ]);
  });

  it("should fail when EventBridge reports a failed entry", async () => {
    const { fetchImpl } = fakeAwsFetch({ failedEntryCount: 1 });
    const outcome = await putDeployEvent({ ...INPUT, fetchImpl });
    expect(outcome.ok).toBe(false);
  });

  it("should fail on a non-2xx publish response", async () => {
    const { fetchImpl } = fakeAwsFetch({ putEventsStatus: StatusCodes.INTERNAL_SERVER_ERROR });
    expect(await putDeployEvent({ ...INPUT, fetchImpl })).toEqual({
      ok: false,
      status: StatusCodes.INTERNAL_SERVER_ERROR,
    });
  });

  it("should fail when the publish transport is unreachable", async () => {
    const failingFetch = (async () => {
      throw new Error("connect timeout");
    }) as unknown as typeof fetch;
    expect(await putDeployEvent({ ...INPUT, fetchImpl: failingFetch })).toEqual({ ok: false });
  });

  it("should fail when the publish response body is not JSON", async () => {
    const { fetchImpl } = fakeAwsFetch();
    const textFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await fetchImpl(input, init);
      return new Response("not-json");
    }) as unknown as typeof fetch;
    const outcome = await putDeployEvent({ ...INPUT, fetchImpl: textFetch });
    expect(outcome.ok).toBe(false);
  });
});
