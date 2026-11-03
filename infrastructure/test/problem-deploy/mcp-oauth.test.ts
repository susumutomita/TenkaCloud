import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyMcpAccessToken } from "../../lib/problem-deploy/handlers/participant-handler/mcp-oauth.js";
import { mcpIssuer, parseMcpOAuthConfig } from "../../lib/problem-deploy/mcp-oauth-config.js";
import { participantMcpCognito } from "../../lib/problem-deploy/participant-mcp-cognito.js";
import { mcpConfigFixture } from "./mcp-oauth-fixture.js";

let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(signing.publicKey)), kid: "test-key", alg: "RS256" }],
  });
});
async function token(overrides: Record<string, unknown> = {}) {
  const config = mcpConfigFixture();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: mcpIssuer(config),
    aud: config.resourceUrl,
    sub: config.bindings[0]?.subject,
    iat: now,
    exp: now + 300,
    token_use: "access",
    client_id: "mcp-test-client",
    scope: `${config.resourceUrl}/read ${config.resourceUrl}/submit`,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(signing.privateKey);
}

describe("Cognito participant MCP authorization", () => {
  it("accepts only the signed resource-bound access token and explicit team delegation", async () => {
    const config = mcpConfigFixture();
    const principal = await verifyMcpAccessToken(await token(), config, "mcp-test-client", keys);
    expect(principal.binding.teamId).toBe(config.bindings[0]?.teamId);
    expect(principal.allowSubmit).toBe(true);
    const read = await verifyMcpAccessToken(
      await token({ scope: `${config.resourceUrl}/read` }),
      config,
      "mcp-test-client",
      keys,
    );
    expect(read.allowSubmit).toBe(false);
    const deniedPolicy = {
      ...config,
      bindings: config.bindings.map((binding) => ({ ...binding, allowSubmit: false })),
    };
    expect(
      (await verifyMcpAccessToken(await token(), deniedPolicy, "mcp-test-client", keys))
        .allowSubmit,
    ).toBe(false);
  });
  it("rejects forged, expired, wrong issuer/audience/client/type/scope and unbound subjects", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { iss: "https://attacker.example.test" },
      { aud: "https://other.example.test/mcp" },
      { client_id: "organizer-client" },
      { token_use: "id" },
      { scope: "openid" },
      { sub: "00000000-0000-4000-8000-000000000099" },
      { exp: now - 10 },
      { iat: now - 400, exp: now + 100 },
      { exp: now + 3600 },
      { iat: now + 120, exp: now + 300 },
    ])
      await expect(
        verifyMcpAccessToken(await token(claims), mcpConfigFixture(), "mcp-test-client", keys),
      ).rejects.toThrow();
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(other.privateKey);
    await expect(
      verifyMcpAccessToken(forged, mcpConfigFixture(), "mcp-test-client", keys),
    ).rejects.toThrow();
    await expect(
      verifyMcpAccessToken("raw-team-key", mcpConfigFixture(), "mcp-test-client", keys),
    ).rejects.toThrow();
  });
  it("enforces binding expiry and revocation cutoff", async () => {
    const config = mcpConfigFixture();
    const now = Math.floor(Date.now() / 1000);
    const signed = await token({ iat: now - 20 });
    for (const policy of [{ notBefore: now - 10 }, { expiresAt: now - 1 }]) {
      const revoked = {
        ...config,
        bindings: config.bindings.map((entry) => ({ ...entry, ...policy })),
      };
      await expect(
        verifyMcpAccessToken(signed, revoked, "mcp-test-client", keys),
      ).rejects.toThrow();
    }
  });
  it("validates explicit configuration and never silently supplies a default binding", () => {
    const config = mcpConfigFixture();
    expect(parseMcpOAuthConfig(undefined)).toBeUndefined();
    expect(parseMcpOAuthConfig(JSON.stringify(config))).toEqual(config);
    for (const changes of [
      { resourceUrl: "http://example.test/mcp" },
      { bindings: [...config.bindings, ...config.bindings] },
      { bindings: [] },
      { bindings: config.bindings.map((entry) => ({ ...entry, expiresAt: entry.notBefore })) },
      {
        bindings: config.bindings.map((entry) => ({
          ...entry,
          jobIds: [...entry.jobIds, ...entry.jobIds],
        })),
      },
      { callbackUrls: ["http://attacker.example.test/callback"] },
    ])
      expect(() => parseMcpOAuthConfig(JSON.stringify({ ...config, ...changes }))).toThrow();
  });
  it("adds an opt-in public code client to the existing pool, without modifying its organizer client", () => {
    const stack = new Stack(new App({ autoSynth: false }), "McpTest");
    const config = mcpConfigFixture();
    const result = participantMcpCognito(stack, config);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPool", 0);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      UserPoolId: config.userPoolId,
      GenerateSecret: false,
      ReadAttributes: ["email", "email_verified"],
      WriteAttributes: ["email"],
      AllowedOAuthFlows: ["code"],
      CallbackURLs: config.callbackUrls,
      AccessTokenValidity: 5,
      RefreshTokenValidity: 60,
      TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes", RefreshToken: "minutes" },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      UserPoolId: config.userPoolId,
      Identifier: config.resourceUrl,
    });
    template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
      UserPoolId: config.userPoolId,
      UseCognitoProvidedValues: true,
    });
    expect(result.environment).toHaveProperty("MCP_OAUTH_CLIENT_ID");
    const noConfig = new Stack(new App({ autoSynth: false }), "Disabled");
    expect(participantMcpCognito(noConfig, undefined)).toEqual({
      environment: {},
      bundledData: {},
    });
    Template.fromStack(noConfig).resourceCountIs("AWS::Cognito::UserPoolClient", 0);
  });
});
