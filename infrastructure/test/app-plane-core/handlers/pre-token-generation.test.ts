import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  handler,
  LITE_TENANT_ADMIN_ROLE,
  LITE_TENANT_ID,
} from "../../../lib/app-plane-core/handlers/pre-token-generation/index.js";

/**
 * Issue #1327: Pre-Token Generation handler の契約 pin。
 *
 * Cognito の trigger 仕様 (= 同期 / event mutate 経由で JWT claim を上書き) を
 * input → output で固定する。 SaaS mode handler の `requireRole(c, [TENANT_ADMIN_ROLE])` +
 * `resolveTenantId(c)` が成立するために必要な 2 claim (`custom:userRole` / `custom:tenantId`)
 * が必ず注入されることを保証する。
 */

function buildEvent(
  overrides?: Partial<PreTokenGenerationTriggerEvent>,
): PreTokenGenerationTriggerEvent {
  return {
    version: "1",
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
    },
    response: {
      claimsOverrideDetails: null,
    },
    ...overrides,
  } as PreTokenGenerationTriggerEvent;
}

describe("Pre-Token Generation handler (#1327)", () => {
  it("should inject custom:userRole=TenantAdmin and custom:tenantId=local into JWT claims", async () => {
    const event = buildEvent();
    const result = await handler(event, {} as never, () => undefined);
    expect(result).toBeDefined();
    const claims =
      (result as PreTokenGenerationTriggerEvent).response.claimsOverrideDetails
        ?.claimsToAddOrOverride ?? {};
    expect(claims["custom:userRole"]).toBe("TenantAdmin");
    expect(claims["custom:tenantId"]).toBe("local");
  });

  it("should preserve the input event shape (Cognito trigger contract: handler returns the mutated event)", async () => {
    const event = buildEvent();
    const result = (await handler(
      event,
      {} as never,
      () => undefined,
    )) as PreTokenGenerationTriggerEvent;
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
    )) as PreTokenGenerationTriggerEvent;
    const claims = result.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
    expect(claims["custom:userRole"]).toBe("TenantAdmin");
    expect(claims["custom:tenantId"]).toBe("local");
  });

  it("should export constants matching the Application Plane handler expectations", () => {
    // SaaS mode handler が require する `TENANT_ADMIN_ROLE` 値と一致していること。
    expect(LITE_TENANT_ADMIN_ROLE).toBe("TenantAdmin");
    // Lite mode の固定 tenantId (= TenkaCloudLiteStack の LITE_TENANT_ID と一致)。
    expect(LITE_TENANT_ID).toBe("local");
  });
});
