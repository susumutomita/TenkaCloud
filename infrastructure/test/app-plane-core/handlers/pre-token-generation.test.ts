import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  handler,
  LITE_TENANT_ADMIN_ROLE,
  LITE_TENANT_ID,
} from "../../../lib/app-plane-core/handlers/pre-token-generation/index.js";

/**
 * Issue #1327 / #1358: Pre-Token Generation V2 handler の契約 pin。
 *
 * Cognito の V2 trigger 仕様 (= 同期 / event mutate 経由で id_token / access_token の
 * 両方に claim を上書き) を input → output で固定する。 SaaS mode handler の
 * `requireRole(c, [TENANT_ADMIN_ROLE])` + `resolveTenantId(c)` が成立するために必要な 2 claim
 * (`custom:userRole` / `custom:tenantId`) が **id_token と access_token の双方** に必ず
 * 注入されることを保証する (#1358 の regression を pin)。
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

describe("Pre-Token Generation V2 handler (#1327 / #1358)", () => {
  it("should inject custom:userRole=TenantAdmin and custom:tenantId=local into the ID token (#1358 root cause)", async () => {
    const event = buildEvent();
    const result = await handler(event, {} as never, () => undefined);
    expect(result).toBeDefined();
    const idClaims =
      (result as PreTokenGenerationV2TriggerEvent).response.claimsAndScopeOverrideDetails
        ?.idTokenGeneration?.claimsToAddOrOverride ?? {};
    expect(idClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(idClaims["custom:tenantId"]).toBe("local");
  });

  it("should also inject claims into the access token so API Gateway / Lambda authorizers see them regardless of token type", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    const accessClaims =
      result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride ??
      {};
    expect(accessClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(accessClaims["custom:tenantId"]).toBe("local");
  });

  it("should preserve the input event shape (Cognito trigger contract: handler returns the mutated event)", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    // Cognito requires the handler to return the event (sync invoke). Confirm identity is preserved.
    expect(result.userPoolId).toBe(event.userPoolId);
    expect(result.userName).toBe(event.userName);
    expect(result.triggerSource).toBe(event.triggerSource);
  });

  it("should override existing custom:userRole / custom:tenantId if the user attribute is already set", async () => {
    // Lite mode は 1 tenant 前提なので、 仮に user attribute に別 role/tenant が入っていても
    // JWT 上は強制 TenantAdmin / local に倒す (= 運用契約)。
    const event = buildEvent();
    event.request.userAttributes["custom:userRole"] = "ReadOnly";
    event.request.userAttributes["custom:tenantId"] = "some-other-tenant";
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    const idClaims =
      result.response.claimsAndScopeOverrideDetails?.idTokenGeneration?.claimsToAddOrOverride ?? {};
    const accessClaims =
      result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride ??
      {};
    expect(idClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(idClaims["custom:tenantId"]).toBe("local");
    expect(accessClaims["custom:userRole"]).toBe("TenantAdmin");
    expect(accessClaims["custom:tenantId"]).toBe("local");
  });

  it("should emit groupOverrideDetails as an empty object so existing UserPool groups are preserved", async () => {
    // V2 contract: `groupOverrideDetails: {}` を明示的に空オブジェクトで返すことで
    // 「未指定 = 既存 group を尊重」 が意図であることを pin する。 Lite mode は UserPool
    // group 経路を使わないため、 ここで意図せず group を override しない保証になる。
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationV2TriggerEvent;
    const groupOverride = result.response.claimsAndScopeOverrideDetails?.groupOverrideDetails;
    expect(groupOverride).toBeDefined();
    // 空オブジェクトであることを確認 (= groupsToOverride / iamRolesToOverride / preferredRole 未指定)。
    expect(Object.keys(groupOverride ?? {}).length).toBe(0);
  });

  it("should export constants matching the Application Plane handler expectations", () => {
    // SaaS mode handler が require する `TENANT_ADMIN_ROLE` 値と一致していること。
    expect(LITE_TENANT_ADMIN_ROLE).toBe("TenantAdmin");
    // Lite mode の固定 tenantId (= TenkaCloudLiteStack の LITE_TENANT_ID と一致)。
    expect(LITE_TENANT_ID).toBe("local");
  });
});
