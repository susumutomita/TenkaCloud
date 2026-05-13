import { describe, expect, it } from "vitest";
import { decideReconcile } from "../../lib/tenant-status-reconciler/status-policy";

const NOW = Date.parse("2026-05-13T22:00:00.000Z");

describe("decideReconcile", () => {
  it('status が "In progress" でない場合は skip すべき (= 既に Complete/Failed/Deleted は触らない)', () => {
    expect(
      decideReconcile({
        tenantStatus: "Complete",
        tenantConfig: undefined,
        createdAt: undefined,
        nowMs: NOW,
      }).action,
    ).toBe("skip");
    expect(
      decideReconcile({
        tenantStatus: "Failed",
        tenantConfig: undefined,
        createdAt: undefined,
        nowMs: NOW,
      }).action,
    ).toBe("skip");
  });

  it('status が "In progress" + tenantConfig に applicationAdminConsoleUrl 充足 → complete', () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: '{"applicationAdminConsoleUrl":"https://d123.cloudfront.net"}',
      createdAt: "2026-05-13T21:55:00.000Z",
      nowMs: NOW,
    });
    expect(out.action).toBe("complete");
  });

  it('"IN_PROGRESS" (大文字) でも同じく判定すべき (= case-insensitive)', () => {
    expect(
      decideReconcile({
        tenantStatus: "IN_PROGRESS",
        tenantConfig: '{"applicationAdminConsoleUrl":"https://x.cloudfront.net"}',
        createdAt: "2026-05-13T21:55:00.000Z",
        nowMs: NOW,
      }).action,
    ).toBe("complete");
  });

  it('"Provisioning" (SBT v0.3.10 系) でも同じく判定すべき', () => {
    expect(
      decideReconcile({
        tenantStatus: "Provisioning",
        tenantConfig: '{"userPoolId":"ap-northeast-1_abc"}',
        createdAt: "2026-05-13T21:55:00.000Z",
        nowMs: NOW,
      }).action,
    ).toBe("complete");
  });

  it("tenantConfig が userPoolId のみでも complete 判定 (= silo deploy 経路)", () => {
    expect(
      decideReconcile({
        tenantStatus: "In progress",
        tenantConfig: '{"userPoolId":"ap-northeast-1_xyz"}',
        createdAt: "2026-05-13T21:55:00.000Z",
        nowMs: NOW,
      }).action,
    ).toBe("complete");
  });

  it("tenantConfig が空 / なし + 60 分未満 → skip (= まだ進行中)", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: undefined,
      createdAt: "2026-05-13T21:45:00.000Z", // 15 分前
      nowMs: NOW,
    });
    expect(out.action).toBe("skip");
  });

  it("tenantConfig 空 + 60 分超 → fail + reason", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: undefined,
      createdAt: "2026-05-13T20:50:00.000Z", // 70 分前
      nowMs: NOW,
    });
    expect(out.action).toBe("fail");
    if (out.action === "fail") {
      expect(out.reason).toMatch(/timed out/i);
    }
  });

  it("tenantConfig が malformed JSON でも fall through (= skip / fail に降りる)", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: "{ not-json",
      createdAt: "2026-05-13T21:55:00.000Z",
      nowMs: NOW,
    });
    expect(out.action).toBe("skip");
  });

  it("tenantConfig に他の field のみ (= applicationAdminConsoleUrl / userPoolId 無し) は skip", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: '{"someOther":"value"}',
      createdAt: "2026-05-13T21:55:00.000Z",
      nowMs: NOW,
    });
    expect(out.action).toBe("skip");
  });

  it("createdAt が parse 不能でも skip (= 60 分判定をスキップ)", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: undefined,
      createdAt: "not-an-iso-date",
      nowMs: NOW,
    });
    expect(out.action).toBe("skip");
  });

  it("createdAt が未来 (clock skew) でも fail にはならない (= 経過時間が負になっても閾値超過しない)", () => {
    const out = decideReconcile({
      tenantStatus: "In progress",
      tenantConfig: undefined,
      createdAt: "2026-05-13T22:30:00.000Z", // 30 分後
      nowMs: NOW,
    });
    expect(out.action).toBe("skip");
  });
});
