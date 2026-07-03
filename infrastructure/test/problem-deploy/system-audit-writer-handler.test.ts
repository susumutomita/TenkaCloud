import type { EventBridgeEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: system-audit-writer の EventBridge handler (index.ts 142-164) を pin する。
 * 既存テストは pure mapper (mapEventToAudit / resolveActor / mapCodeBuildEvent) を直接叩くが、
 * async handler (writeAuditEvent への配線 + optional field 組立 + fail-safe swallow) が未カバー。
 *
 * writeAuditEvent のみ mock。 mapper は実物を通す。
 */
const mocks = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/shared/audit-log", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

const { handler } = await import("../../lib/problem-deploy/handlers/system-audit-writer/index");

// biome-ignore lint/suspicious/noExplicitAny: 最小 EventBridgeEvent を直接組む。
const ev = (detailType: string, detail: Record<string, unknown>, time?: string): any =>
  ({ "detail-type": detailType, detail, time }) as EventBridgeEvent<string, never>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditEvent.mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("system-audit-writer handler", () => {
  it("should skip a non-audit-worthy event without writing", async () => {
    await handler(ev("SomeUnrelatedEvent", {}));
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("should write a full SBT onboarding row (actorUsername / target / extra present)", async () => {
    await handler(
      ev(
        "onboardingSuccess",
        {
          tenantId: "tenant-9",
          tier: "PREMIUM",
          tenantName: "Acme",
          sub: "sub-1",
          cognitoUsername: "admin@example.com",
        },
        "2026-06-01T00:00:00.000Z",
      ),
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "SYSTEM",
        action: "tenant_create_succeeded",
        outcome: "success",
        target: "tenant-9",
        actor: "sub-1",
        actorUsername: "admin@example.com",
        occurredAtMs: Date.parse("2026-06-01T00:00:00.000Z"),
        extra: { tier: "PREMIUM", tenantName: "Acme" },
      }),
    );
  });

  it("should write a minimal row, omitting absent optional fields", async () => {
    await handler(ev("onboardingRequest", {})); // no actor / target / tier / tenantName
    const arg = mocks.writeAuditEvent.mock.calls[0][0];
    expect(arg.actor).toBe("sbt-control-plane"); // fallback
    expect(arg).not.toHaveProperty("actorUsername");
    expect(arg).not.toHaveProperty("target");
    expect(arg).not.toHaveProperty("extra");
  });

  it("should swallow an Error from writeAuditEvent (no throw)", async () => {
    mocks.writeAuditEvent.mockRejectedValueOnce(new Error("ddb down"));
    await expect(handler(ev("onboardingFailure", { tenantId: "t" }))).resolves.toBeUndefined();
  });

  it("should swallow a non-Error rejection (String(err) branch)", async () => {
    mocks.writeAuditEvent.mockRejectedValueOnce("plain string failure");
    await expect(handler(ev("offboardingSuccess", { tenantId: "t" }))).resolves.toBeUndefined();
  });

  it("should write a CodeBuild FAILED row, defaulting time and omitting region/build-id", async () => {
    // no event.time → occurredAtMs falls back to Date.now(); no region / build-id → extra omits them.
    await handler(
      ev("CodeBuild Build State Change", {
        "build-status": "FAILED",
        "project-name": "tenant-pipe",
      }),
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codebuild_failed",
        outcome: "error",
        actor: "codebuild",
        target: "tenant-pipe",
        extra: { buildStatus: "FAILED" },
      }),
    );
  });

  it("should write a CodeBuild FAILED row with time + region + build-id present", async () => {
    await handler(
      ev(
        "CodeBuild Build State Change",
        {
          "build-status": "FAILED",
          "project-name": "tenant-pipe",
          "build-id": "build-123",
          region: "ap-northeast-1",
        },
        "2026-06-01T00:00:00.000Z",
      ),
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAtMs: Date.parse("2026-06-01T00:00:00.000Z"),
        extra: { buildStatus: "FAILED", buildId: "build-123", region: "ap-northeast-1" },
      }),
    );
  });

  it("should skip a SUCCEEDED CodeBuild event", async () => {
    await handler(ev("CodeBuild Build State Change", { "build-status": "SUCCEEDED" }));
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("should write a deploy_failed row through the handler (Issue #2291)", async () => {
    await handler(
      ev(
        "TenkaCloud Deploy Failed",
        {
          jobId: "01HXJOB",
          tenantId: "tenant-acme",
          problemId: "hello-world",
          region: "ap-northeast-1",
          failureReason: "CREATE_FAILED: boom",
        },
        "2026-07-01T09:00:00.000Z",
      ),
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "SYSTEM",
        action: "deploy_failed",
        outcome: "error",
        target: "hello-world",
        actor: "problem-deploy",
        occurredAtMs: Date.parse("2026-07-01T09:00:00.000Z"),
        extra: {
          jobId: "01HXJOB",
          region: "ap-northeast-1",
          tenantId: "tenant-acme",
          failureReason: "CREATE_FAILED: boom",
        },
      }),
    );
  });
});
