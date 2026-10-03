import { describe, expect, it, vi } from "vitest";
import { createGcpStsRestClient } from "../../lib/problem-deploy/runtime-clients/gcp-sts-rest-client.js";

/**
 * [#1411] GCP STS + IAM Credentials REST client の wire を pin。 fetch を mock し、
 * token-exchange の body (grantType / requestedTokenType / subjectToken) / SA impersonation の
 * Authorization + lifetime / access_token・accessToken 抽出 / 非2xx throw を観測する。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createGcpStsRestClient({
    stsBaseUrl: "https://sts.test/v1",
    iamCredentialsBaseUrl: "https://iam.test/v1",
    fetchImpl: fetchImpl as never,
  });
}

describe("gcp-sts-rest-client (#1411)", () => {
  it("should POST a token-exchange with the grant/requested types and subject token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "fed-token", expires_in: 3600 }));
    const out = await client(fetchImpl).exchangeToken({
      audience: "//iam.googleapis.com/.../providers/aws",
      subjectToken: "signed-gci",
      subjectTokenType: "urn:ietf:params:aws:token-type:aws4_request",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
    expect(out).toEqual({ access_token: "fed-token", expires_in: 3600 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://sts.test/v1/token");
    const body = JSON.parse(init.body);
    expect(body.grantType).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(body.requestedTokenType).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.subjectToken).toBe("signed-gci");
    expect(body.subjectTokenType).toBe("urn:ietf:params:aws:token-type:aws4_request");
  });

  it("should throw when token-exchange lacks an access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ expires_in: 1 }));
    await expect(
      client(fetchImpl).exchangeToken({
        audience: "a",
        subjectToken: "s",
        subjectTokenType: "t",
        scope: "x",
      }),
    ).rejects.toThrow(/missing access_token/);
  });

  it("should impersonate the service account with Bearer federated token + lifetime", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "sa-token", expireTime: "2026-01-01T00:00:00Z" }),
      );
    const out = await client(fetchImpl).generateServiceAccountToken({
      serviceAccountEmail: "deployer@proj.iam.gserviceaccount.com",
      federatedToken: "fed-token",
      lifetimeSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(out.accessToken).toBe("sa-token");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://iam.test/v1/projects/-/serviceAccounts/deployer%40proj.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(init.headers.Authorization).toBe("Bearer fed-token");
    const body = JSON.parse(init.body);
    expect(body.lifetime).toBe("3600s");
    expect(body.scope).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
  });

  it("should throw on a non-2xx STS / impersonation response", async () => {
    const sts = vi.fn().mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(
      client(sts).exchangeToken({
        audience: "a",
        subjectToken: "s",
        subjectTokenType: "t",
        scope: "x",
      }),
    ).rejects.toThrow(/403/);
  });
});
