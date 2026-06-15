import { describe, expect, it } from "vitest";
import { decodeIdToken, resolveTenantConsoleAccess } from "../src/auth/claims";

/**
 * Cognito id_token payload デコード util。 署名検証は API GW authorizer 側なので
 * frontend は base64url + UTF-8 デコードのみ。 不正 token (= part 数違い / base64 不正 /
 * 非 JSON) は throw せず null に倒す (= 画面を壊さない) ことを pin する。
 */
function b64url(value: object | string): string {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload: object): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

describe("decodeIdToken", () => {
  it("should decode the standard + custom Cognito claims, including multi-byte names", () => {
    const token = makeJwt({
      sub: "user-1",
      email: "tenant-admin@acme.example",
      "custom:tenantId": "01HXTENANT00000000000000AB",
      "custom:userRole": "TenantAdmin",
      "custom:tenantTier": "PLATINUM",
      // UTF-8 multi-byte を TextDecoder 経路が正しく復号できることを確認する。
      "custom:tenantName": "天下クラウド株式会社",
    });
    const claims = decodeIdToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("user-1");
    expect(claims?.email).toBe("tenant-admin@acme.example");
    expect(claims?.["custom:tenantId"]).toBe("01HXTENANT00000000000000AB");
    expect(claims?.["custom:userRole"]).toBe("TenantAdmin");
    expect(claims?.["custom:tenantTier"]).toBe("PLATINUM");
    expect(claims?.["custom:tenantName"]).toBe("天下クラウド株式会社");
  });

  it("should decode Cognito groups when the claim is an array", () => {
    const token = makeJwt({
      sub: "user-1",
      "cognito:groups": ["viewer"],
    });
    expect(decodeIdToken(token)?.["cognito:groups"]).toEqual(["viewer"]);
  });

  it("should return null when the token is not a 3-part JWT", () => {
    expect(decodeIdToken("only.two")).toBeNull();
    expect(decodeIdToken("a.b.c.d")).toBeNull();
    expect(decodeIdToken("")).toBeNull();
  });

  it("should return null when the payload segment is not valid base64", () => {
    // `***` は base64 に存在しない文字 → atob が throw → catch → null。
    expect(decodeIdToken("header.***.signature")).toBeNull();
  });

  it("should return null when the decoded payload is not JSON", () => {
    // 有効な base64 だが中身は素のテキスト → JSON.parse が throw → null。
    expect(decodeIdToken(`header.${b64url("not-json-payload")}.signature`)).toBeNull();
  });
});

describe("resolveTenantConsoleAccess", () => {
  it("should allow mutation for TenantAdmin, TenantOperator, and editor-style groups", () => {
    expect(resolveTenantConsoleAccess({ "custom:userRole": "TenantAdmin" }).canMutateTenant).toBe(
      true,
    );
    expect(
      resolveTenantConsoleAccess({ "custom:userRole": "TenantOperator" }).canMutateTenant,
    ).toBe(true);
    expect(resolveTenantConsoleAccess({ "cognito:groups": ["editor"] }).canMutateTenant).toBe(true);
    expect(resolveTenantConsoleAccess({ "cognito:groups": "viewer editor" }).role).toBe("editor");
  });

  it("should deny mutation for TenantViewer, viewer groups, missing, or unknown roles", () => {
    expect(resolveTenantConsoleAccess({ "custom:userRole": "TenantViewer" }).canMutateTenant).toBe(
      false,
    );
    expect(resolveTenantConsoleAccess({ "cognito:groups": ["viewer"] }).canMutateTenant).toBe(
      false,
    );
    expect(resolveTenantConsoleAccess({ "custom:userRole": "mystery" }).canMutateTenant).toBe(
      false,
    );
    expect(resolveTenantConsoleAccess(null).canMutateTenant).toBe(false);
  });
});
