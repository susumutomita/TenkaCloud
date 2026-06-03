import { describe, expect, it } from "vitest";
import { cognitoOrigin, spEntityId, userPoolIdFromIssuer } from "./cognito";

/**
 * Regression: the Test sign-in link built `https://${cognitoDomain}` where cognitoDomain already
 * had a scheme, yielding `https://https://…` → a dead host. cognitoOrigin must add the scheme at
 * most once and produce a valid base for `new URL(path, origin)`.
 */
describe("cognitoOrigin", () => {
  const DOMAIN = "tenkacloud-development-local-672726205532.auth.ap-northeast-1.amazoncognito.com";

  it("should add https:// to a scheme-less domain", () => {
    expect(cognitoOrigin(DOMAIN)).toBe(`https://${DOMAIN}`);
  });

  it("should NOT double the scheme when the domain already has https://", () => {
    expect(cognitoOrigin(`https://${DOMAIN}`)).toBe(`https://${DOMAIN}`);
  });

  it("should preserve an http:// scheme (no forced upgrade, no doubling)", () => {
    expect(cognitoOrigin("http://localhost:9000")).toBe("http://localhost:9000");
  });

  it("should strip a trailing slash and surrounding whitespace", () => {
    expect(cognitoOrigin(`  https://${DOMAIN}/  `)).toBe(`https://${DOMAIN}`);
  });

  it("should compose a valid absolute URL with new URL(path, origin)", () => {
    const url = new URL("/oauth2/authorize", cognitoOrigin(`https://${DOMAIN}`));
    expect(url.toString()).toBe(`https://${DOMAIN}/oauth2/authorize`);
    expect(url.host).toBe(DOMAIN); // host is the real domain, not "https"
  });
});

describe("userPoolIdFromIssuer + spEntityId", () => {
  it("should extract the User Pool ID from a Cognito iss claim", () => {
    expect(
      userPoolIdFromIssuer(
        "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_AbCd123",
      ),
    ).toBe("ap-northeast-1_AbCd123");
  });

  it("should return undefined for a missing or non-Cognito issuer", () => {
    expect(userPoolIdFromIssuer(undefined)).toBeUndefined();
    expect(userPoolIdFromIssuer("https://accounts.google.com")).toBeUndefined();
  });

  it("should build the real SP Entity ID when the pool id is known", () => {
    expect(spEntityId("ap-northeast-1_AbCd123")).toBe(
      "urn:amazon:cognito:sp:ap-northeast-1_AbCd123",
    );
  });

  it("should fall back to the placeholder only when the pool id is unknown", () => {
    expect(spEntityId(undefined)).toBe("urn:amazon:cognito:sp:<userPoolId>");
  });
});
