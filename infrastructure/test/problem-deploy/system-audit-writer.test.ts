import type { EventBridgeEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  mapEventToAudit,
  resolveActor,
  type SbtTenantEventDetailType,
} from "../../lib/problem-deploy/handlers/system-audit-writer";

/**
 * Issue #1034: SBT tenant onboarding/offboarding event → audit row 変換の pure logic を pin する。
 * Lambda 全体は IAM / EventBridge Rule との配線が要るので CDK test 側で synth assertion する。
 */
function buildEvent(
  detailType: SbtTenantEventDetailType,
  detail: Record<string, unknown> = {},
  time = "2026-05-19T09:00:00.000Z",
): EventBridgeEvent<string, Record<string, unknown>> {
  return {
    version: "0",
    id: "evt-1",
    "detail-type": detailType,
    source: "sbt-control-plane-api",
    account: "123456789012",
    time,
    region: "ap-northeast-1",
    resources: [],
    detail,
  };
}

describe("system-audit-writer (Issue #1034)", () => {
  describe("mapEventToAudit", () => {
    it("onboardingRequest を tenant_create_requested + success として SYSTEM scope に書くべき", () => {
      const event = buildEvent("onboardingRequest", { tenantId: "t-01", tier: "STANDARD" });
      const row = mapEventToAudit(event);
      expect(row).not.toBeNull();
      expect(row?.tenantId).toBe("SYSTEM");
      expect(row?.action).toBe("tenant_create_requested");
      expect(row?.outcome).toBe("success");
      expect(row?.target).toBe("t-01");
      expect(row?.extra.tier).toBe("STANDARD");
    });

    it("onboardingFailure は outcome=error に倒すべき", () => {
      const row = mapEventToAudit(buildEvent("onboardingFailure", { tenantId: "t-02" }));
      expect(row?.outcome).toBe("error");
      expect(row?.action).toBe("tenant_create_failed");
    });

    it("offboardingRequest は tenant_delete_requested を返すべき", () => {
      const row = mapEventToAudit(buildEvent("offboardingRequest", { tenantId: "t-03" }));
      expect(row?.action).toBe("tenant_delete_requested");
      expect(row?.outcome).toBe("success");
    });

    it("offboardingSuccess は tenant_delete_succeeded を返すべき", () => {
      const row = mapEventToAudit(buildEvent("offboardingSuccess", { tenantId: "t-03" }));
      expect(row?.action).toBe("tenant_delete_succeeded");
    });

    it("offboardingFailure は outcome=error に倒すべき", () => {
      const row = mapEventToAudit(buildEvent("offboardingFailure", { tenantId: "t-03" }));
      expect(row?.outcome).toBe("error");
      expect(row?.action).toBe("tenant_delete_failed");
    });

    it("未知の detail-type は null を返して skip すべき", () => {
      const row = mapEventToAudit(
        buildEvent("unknownEvent" as SbtTenantEventDetailType, { tenantId: "t-x" }),
      );
      expect(row).toBeNull();
    });

    it("event.time から occurredAtMs を抽出すべき (= EventBridge が記録した実発生時刻を保持)", () => {
      const row = mapEventToAudit(
        buildEvent("onboardingSuccess", { tenantId: "t-04" }, "2026-04-01T12:34:56.000Z"),
      );
      expect(row?.occurredAtMs).toBe(new Date("2026-04-01T12:34:56.000Z").getTime());
    });

    it("tenantName / tier がある時は extra に含めるべき", () => {
      const row = mapEventToAudit(
        buildEvent("onboardingSuccess", { tenantId: "t-05", tenantName: "Acme", tier: "PLATINUM" }),
      );
      expect(row?.extra).toEqual({ tenantName: "Acme", tier: "PLATINUM" });
    });
  });

  describe("resolveActor", () => {
    it("detail.sub があれば優先すべき (= Cognito 安定識別子)", () => {
      expect(resolveActor({ sub: "cog-sub-1", cognitoUsername: "alice@example" })).toEqual({
        actor: "cog-sub-1",
        actorUsername: "alice@example",
      });
    });

    it("detail.sub が無ければ actor field を見るべき", () => {
      expect(resolveActor({ actor: "fallback-actor" })).toEqual({ actor: "fallback-actor" });
    });

    it("いずれも無ければ sbt-control-plane を fallback とすべき", () => {
      expect(resolveActor({})).toEqual({ actor: "sbt-control-plane" });
    });

    it("cognitoUsername と username の両方があれば cognitoUsername を優先すべき", () => {
      expect(resolveActor({ sub: "s", cognitoUsername: "a", username: "b" })).toEqual({
        actor: "s",
        actorUsername: "a",
      });
    });
  });
});
