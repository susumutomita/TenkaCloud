import { env } from "cloudflare:workers";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Fixed P-256 test vector: KID is the RFC 7638 thumbprint of the public
 * members (SHA-256 over {"crv","kty","x","y"} in lexicographic order),
 * precomputed independently of the implementation under test.
 */
const PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "1eKmOOWu-FOaKedtieKvK2YrtlFl7GaMzDoAq36I07c",
  y: "LT1bJ_zI98s8BQxrpCV1MhuCO7CrO8VfLVLt5zqP4D8",
  d: "nGPyjamYMjRaOqgyKGX6uktZkAEXUb8ujIXC1JtGDX0",
};
const THUMBPRINT_KID = "Nnp5gUjUmY5woKSydtp5r2b22Pnqxk1IpNvHeozhJnw";

const ORIGIN = "https://control.example";

function withOidcKey(privateJwk: unknown = PRIVATE_JWK) {
  return {
    ...env,
    OIDC_SIGNING_PRIVATE_JWK:
      typeof privateJwk === "string" ? privateJwk : JSON.stringify(privateJwk),
  };
}

describe("OIDC discovery document", () => {
  it("should serve the fields AWS IAM requires, with the serving origin as issuer", async () => {
    const app = createApp();
    const response = await app.request(`${ORIGIN}/.well-known/openid-configuration`, {}, env);
    expect(response.status).toBe(StatusCodes.OK);
    expect(await response.json()).toEqual({
      issuer: ORIGIN,
      jwks_uri: `${ORIGIN}/.well-known/jwks.json`,
      claims_supported: ["aud", "exp", "iat", "iss", "sub"],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
    });
  });

  it("should not require the signing secret (the document is static)", async () => {
    const app = createApp();
    const response = await app.request(
      `${ORIGIN}/.well-known/openid-configuration`,
      {},
      { ...env, OIDC_SIGNING_PRIVATE_JWK: undefined },
    );
    expect(response.status).toBe(StatusCodes.OK);
  });
});

describe("OIDC JWKS", () => {
  it("should serve only the public half of the signing key", async () => {
    const app = createApp();
    const response = await app.request(`${ORIGIN}/.well-known/jwks.json`, {}, withOidcKey());
    expect(response.status).toBe(StatusCodes.OK);
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(keys).toEqual([
      {
        kty: "EC",
        crv: "P-256",
        x: PRIVATE_JWK.x,
        y: PRIVATE_JWK.y,
        kid: THUMBPRINT_KID,
        use: "sig",
        alg: "ES256",
      },
    ]);
    expect(keys[0]).not.toHaveProperty("d");
    expect(keys[0]).not.toHaveProperty("key_ops");
  });

  it("should strip private and non-JWKS members a real exported key carries", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const app = createApp();
    const response = await app.request(
      `${ORIGIN}/.well-known/jwks.json`,
      {},
      withOidcKey(exported),
    );
    expect(response.status).toBe(StatusCodes.OK);
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual([
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
  });

  it("should honor an explicit kid on the private JWK", async () => {
    const app = createApp();
    const response = await app.request(
      `${ORIGIN}/.well-known/jwks.json`,
      {},
      withOidcKey({ ...PRIVATE_JWK, kid: "rotation-2026-07" }),
    );
    const { keys } = (await response.json()) as { keys: { kid: string }[] };
    expect(keys[0]?.kid).toBe("rotation-2026-07");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not valid JSON", "{nope"],
    ["not a JWK object", JSON.stringify(["not-a-jwk"])],
    ["not an EC key", JSON.stringify({ ...PRIVATE_JWK, kty: "RSA" })],
    ["not P-256", JSON.stringify({ ...PRIVATE_JWK, crv: "P-384" })],
    ["missing x", JSON.stringify({ ...PRIVATE_JWK, x: undefined })],
    ["missing y", JSON.stringify({ ...PRIVATE_JWK, y: "" })],
  ])("should fail loudly when the signing secret is %s", async (_case, secret) => {
    const app = createApp();
    const response = await app.request(
      `${ORIGIN}/.well-known/jwks.json`,
      {},
      { ...env, OIDC_SIGNING_PRIVATE_JWK: secret },
    );
    expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});
