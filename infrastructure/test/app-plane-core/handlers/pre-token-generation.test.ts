import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  handler,
  LITE_TENANT_ADMIN_ROLE,
  LITE_TENANT_ID,
  LITE_TENANT_NAME,
} from "../../../lib/app-plane-core/handlers/pre-token-generation/index.js";

/**
 * Issue #1327 / #1358: Pre-Token Generation V2 handler の契約 pin。
 *
 * Cognito の V2 trigger 仕様 (= 同期 / event mutate 経由で id_token / access_token の双方に
 * claim を上書き) を input → output で固定する。 Application Plane handler の
 * `requireRole(c, ...)` + `resolveTenantId(c)` が成立するための claim
 * (`custom:userRole` / `custom:tenantId` / `custom:tenantName`) が **id_token と access_token の
 * 双方** に注入されることを保証する。
 *
 * role は user の割り当て (`custom:userRole` attribute) を尊重し、 未設定時のみ TenantAdmin に
 * fallback する (= 招待 Viewer/Operator の enforcement と bootstrap 主催者の救済の両立)。
 */

function buildEvent(
  overrides?: Partial<PreTokenGenerationV2TriggerEvent>,
): PreTokenGenerationV2TriggerEvent {
  return {
    version: "2",
    triggerSource: "TokenGeneration_HostedAuth",
    region: "ap-northeast-1",
    userPoolId: "ap-northeast-1_AAA",
    userName: "operator@example.com",
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "client-123" },
    request: {
      userAttributes: {
        sub: "00000000-0000-0000-0000-000000000000",
        email: "operator@example.com",
        email_verified: "true",
      },
      groupConfiguration: {
        groupsToOverride: [],
        iamRolesToOverride: [],
        preferredRole: undefined,
      },
      scopes: ["openid", "email"],
    },
    response: {
      claimsAndScopeOverrideDetails: {},
    },
    ...overrides,
  } as PreTokenGenerationV2TriggerEvent;
}

function idClaimsOf(result: PreTokenGenerationV2TriggerEvent): Record<string, string> {
  return (result.response.claimsAndScopeOverrideDetails?.idTokenGeneration?.claimsToAddOrOverride ??
    {}) as Record<string, string>;
}

function accessClaimsOf(result: PreTokenGenerationV2TriggerEvent): Record<string, string> {
  return (result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration
    ?.claimsToAddOrOverride ?? {}) as Record<string, string>;
}

describe("Pre-Token Generation V2 handler (#1327 / #1358)", () => {
  it("should fall back to TenantAdmin + local + default tenant name when no custom attributes are set", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(result).toBeDefined();
    const idClaims = idClaimsOf(result);
    expect(idClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(idClaims["custom:tenantId"]).toBe("local");
    expect(idClaims["custom:tenantName"]).toBe("TenkaCloud Lite");
  });

  it("should also inject claims into the access token so API Gateway / Lambda authorizers see them regardless of token type", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    const accessClaims = accessClaimsOf(result);
    expect(accessClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(accessClaims["custom:tenantId"]).toBe("local");
    expect(accessClaims["custom:tenantName"]).toBe("TenkaCloud Lite");
  });

  it("should honor the user's assigned role so an invited TenantViewer is not escalated to admin", async () => {
    // 招待時に AdminCreateUser が set した custom:userRole=TenantViewer を尊重する
    // (= broken access control の修正: Viewer が Admin 操作を実行できない)。
    const event = buildEvent();
    event.request.userAttributes["custom:userRole"] = "TenantViewer";
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(idClaimsOf(result)["custom:userRole"]).toBe("TenantViewer");
    expect(accessClaimsOf(result)["custom:userRole"]).toBe("TenantViewer");
    // tenantId は Lite 固定で常に local。
    expect(idClaimsOf(result)["custom:tenantId"]).toBe("local");
  });

  it("should honor a TenantOperator assignment as well", async () => {
    const event = buildEvent();
    event.request.userAttributes["custom:userRole"] = "TenantOperator";
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(idClaimsOf(result)["custom:userRole"]).toBe("TenantOperator");
  });

  it("should fall back to TenantAdmin when the role attribute is not a known tenant role", async () => {
    const event = buildEvent();
    event.request.userAttributes["custom:userRole"] = "BogusRole";
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(idClaimsOf(result)["custom:userRole"]).toBe("TenantAdmin");
  });

  it("should honor an explicit custom:tenantName attribute over the default", async () => {
    const event = buildEvent();
    event.request.userAttributes["custom:tenantName"] = "Acme Drills";
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(idClaimsOf(result)["custom:tenantName"]).toBe("Acme Drills");
  });

  it("should preserve the input event shape (Cognito trigger contract: handler returns the mutated event)", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    expect(result.userPoolId).toBe(event.userPoolId);
    expect(result.userName).toBe(event.userName);
    expect(result.triggerSource).toBe(event.triggerSource);
  });

  it("should emit groupOverrideDetails as an empty object so existing UserPool groups are preserved", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    const groupOverride = result.response.claimsAndScopeOverrideDetails?.groupOverrideDetails;
    expect(groupOverride).toBeDefined();
    expect(Object.keys(groupOverride ?? {}).length).toBe(0);
  });

  it("should export constants matching the Application Plane handler expectations", () => {
    expect(LITE_TENANT_ADMIN_ROLE).toBe("TenantAdmin");
    expect(LITE_TENANT_ID).toBe("local");
    expect(LITE_TENANT_NAME).toBe("TenkaCloud Lite");
  });
});
