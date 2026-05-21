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
    it("should write onboardingRequest as tenant_create_requested + success into the SYSTEM scope", () => {
      const event = buildEvent("onboardingRequest", { tenantId: "t-01", tier: "STANDARD" });
      const row = mapEventToAudit(event);
      expect(row).not.toBeNull();
      expect(row?.tenantId).toBe("SYSTEM");
      expect(row?.action).toBe("tenant_create_requested");
      expect(row?.outcome).toBe("success");
      expect(row?.target).toBe("t-01");
      expect(row?.extra.tier).toBe("STANDARD");
    });

    it("should fall onboardingFailure to outcome=error", () => {
      const row = mapEventToAudit(buildEvent("onboardingFailure", { tenantId: "t-02" }));
      expect(row?.outcome).toBe("error");
      expect(row?.action).toBe("tenant_create_failed");
    });

    it("offboardingRequest should return tenant_delete_requested", () => {
      const row = mapEventToAudit(buildEvent("offboardingRequest", { tenantId: "t-03" }));
      expect(row?.action).toBe("tenant_delete_requested");
      expect(row?.outcome).toBe("success");
    });

    it("offboardingSuccess should return tenant_delete_succeeded", () => {
      const row = mapEventToAudit(buildEvent("offboardingSuccess", { tenantId: "t-03" }));
      expect(row?.action).toBe("tenant_delete_succeeded");
    });

    it("should fall offboardingFailure to outcome=error", () => {
      const row = mapEventToAudit(buildEvent("offboardingFailure", { tenantId: "t-03" }));
      expect(row?.outcome).toBe("error");
      expect(row?.action).toBe("tenant_delete_failed");
    });

    it("should return null and skip unknown detail-types", () => {
      const row = mapEventToAudit(
        buildEvent("unknownEvent" as SbtTenantEventDetailType, { tenantId: "t-x" }),
      );
      expect(row).toBeNull();
    });

    it("should extract occurredAtMs from event.time (preserving EventBridge's recorded occurrence time)", () => {
      const row = mapEventToAudit(
        buildEvent("onboardingSuccess", { tenantId: "t-04" }, "2026-04-01T12:34:56.000Z"),
      );
      expect(row?.occurredAtMs).toBe(new Date("2026-04-01T12:34:56.000Z").getTime());
    });

    it("should include tenantName / tier in extra when present", () => {
      const row = mapEventToAudit(
        buildEvent("onboardingSuccess", { tenantId: "t-05", tenantName: "Acme", tier: "PLATINUM" }),
      );
      expect(row?.extra).toEqual({ tenantName: "Acme", tier: "PLATINUM" });
    });
  });

  describe("CodeBuild Build State Change (Issue #1029)", () => {
    function buildCodeBuildEvent(
      buildStatus: string,
      projectName = "tenkacloud-development-deploy-codebuild",
    ) {
      return {
        version: "0",
        id: "evt-cb-1",
        "detail-type": "CodeBuild Build State Change",
        source: "aws.codebuild",
        account: "123456789012",
        time: "2026-05-19T10:00:00.000Z",
        region: "ap-northeast-1",
        resources: [],
        detail: {
          "build-status": buildStatus,
          "project-name": projectName,
          "build-id": `arn:aws:codebuild:ap-northeast-1:123456789012:build/${projectName}:abc`,
          region: "ap-northeast-1",
        },
      } as const;
    }

    it("should write FAILED builds as codebuild_failed + outcome=error into the SYSTEM scope", () => {
      const row = mapEventToAudit(buildCodeBuildEvent("FAILED"));
      expect(row).not.toBeNull();
      expect(row?.tenantId).toBe("SYSTEM");
      expect(row?.action).toBe("codebuild_failed");
      expect(row?.outcome).toBe("error");
      expect(row?.target).toBe("tenkacloud-development-deploy-codebuild");
      expect(row?.actor).toBe("codebuild");
      expect(row?.extra.buildStatus).toBe("FAILED");
    });

    it("should also audit FAULT / STOPPED / TIMED_OUT (covering silent failures)", () => {
      for (const status of ["FAULT", "STOPPED", "TIMED_OUT"]) {
        const row = mapEventToAudit(buildCodeBuildEvent(status));
        expect(row).not.toBeNull();
        expect(row?.outcome).toBe("error");
        expect(row?.extra.buildStatus).toBe(status);
      }
    });

    it("should not audit SUCCEEDED builds (noise suppression, out of silent-failure scope)", () => {
      expect(mapEventToAudit(buildCodeBuildEvent("SUCCEEDED"))).toBeNull();
    });

    it("should not audit IN_PROGRESS builds (mid-flight state)", () => {
      expect(mapEventToAudit(buildCodeBuildEvent("IN_PROGRESS"))).toBeNull();
    });

    it("should persist build-id into extra.buildId (for CloudWatch Logs deep link)", () => {
      const row = mapEventToAudit(buildCodeBuildEvent("FAILED"));
      expect(row?.extra.buildId).toMatch(/build\//);
    });
  });

  describe("resolveActor", () => {
    it("should prefer detail.sub (Cognito stable identifier)", () => {
      expect(resolveActor({ sub: "cog-sub-1", cognitoUsername: "alice@example" })).toEqual({
        actor: "cog-sub-1",
        actorUsername: "alice@example",
      });
    });

    it("should fall back to the actor field when detail.sub is missing", () => {
      expect(resolveActor({ actor: "fallback-actor" })).toEqual({ actor: "fallback-actor" });
    });

    it("should fall back to sbt-control-plane when none are set", () => {
      expect(resolveActor({})).toEqual({ actor: "sbt-control-plane" });
    });

    it("should prefer cognitoUsername when both cognitoUsername and username are present", () => {
      expect(resolveActor({ sub: "s", cognitoUsername: "a", username: "b" })).toEqual({
        actor: "s",
        actorUsername: "a",
      });
    });
  });
});
