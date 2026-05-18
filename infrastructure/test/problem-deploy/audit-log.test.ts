import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditClient,
  extractAuditContext,
  writeAuditEvent,
} from "../../lib/problem-deploy/handlers/shared/audit-log";

/**
 * Issue #950 (ADR-020 Phase D): writeAuditEvent helper の挙動を pin する。
 *
 * - env ADMIN_AUDIT_LOG_TABLE_NAME が空文字 → no-op で false を返すべき (= 旧 stack 互換)
 * - env 設定済 + 正常書き込み → PutCommand を送信して true を返すべき
 * - DDB 例外 → console.error で警告のみ、 false を返す (= caller の business logic を阻害しない)
 * - tenantId="SYSTEM" は PK="SYSTEM#<env>" に変換されるべき
 */

const ORIGINAL_TABLE = process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
const ORIGINAL_ENV = process.env.DEPLOY_ENVIRONMENT;
beforeEach(() => {
  process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditLog";
  process.env.DEPLOY_ENVIRONMENT = "test-env";
});
afterEach(() => {
  if (ORIGINAL_TABLE === undefined) delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
  else process.env.ADMIN_AUDIT_LOG_TABLE_NAME = ORIGINAL_TABLE;
  if (ORIGINAL_ENV === undefined) delete process.env.DEPLOY_ENVIRONMENT;
  else process.env.DEPLOY_ENVIRONMENT = ORIGINAL_ENV;
});

function buildMockClient(): { client: AuditClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue({});
  return { client: { send: send as never }, send };
}

const baseEvent = {
  tenantId: "t-1",
  actor: "user-sub-1",
  actorUsername: "alice@example.com",
  action: "patch_user_role",
  outcome: "success",
  target: "bob@example.com",
  ipAddress: "203.0.113.5",
  userAgent: "Mozilla/5.0",
  occurredAtMs: Date.UTC(2026, 4, 17, 12, 0, 0),
} as const;

describe("writeAuditEvent (#950)", () => {
  it("env 配線済なら PutCommand を送って true を返すべき", async () => {
    const { client, send } = buildMockClient();
    const ok = await writeAuditEvent(baseEvent, client);
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.TableName).toBe("TestAuditLog");
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.PK).toBe("TENANT#t-1");
    expect(item.SK).toMatch(/^AUDIT#[0-9A-Z]{26}$/);
    expect(item.GSI1PK).toBe("ACTOR#user-sub-1");
    expect(item.actor).toBe("user-sub-1");
    expect(item.actorUsername).toBe("alice@example.com");
    expect(item.action).toBe("patch_user_role");
    expect(item.outcome).toBe("success");
    expect(item.target).toBe("bob@example.com");
    expect(item.occurredAt).toBe("2026-05-17T12:00:00.000Z");
    // ttl = occurredAtMs/1000 + 90*86400
    expect(item.ttl).toBe(Math.floor(baseEvent.occurredAtMs / 1000) + 90 * 86400);
  });

  it("env が空文字なら no-op で false を返すべき (= 旧 stack 互換)", async () => {
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
    const { client, send } = buildMockClient();
    const ok = await writeAuditEvent(baseEvent, client);
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("DDB 例外なら false を返して console.error を出し、 throw しない", async () => {
    const send = vi.fn().mockRejectedValue(new Error("DDB failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok = await writeAuditEvent(baseEvent, { send: send as never });
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("tenantId='SYSTEM' は PK='SYSTEM#<env>' に変換されるべき", async () => {
    const { client, send } = buildMockClient();
    await writeAuditEvent({ ...baseEvent, tenantId: "SYSTEM" }, client);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.PK).toBe("SYSTEM#test-env");
  });

  it("optional fields (target / ipAddress / userAgent / extra) が undefined ならスキップされるべき", async () => {
    const { client, send } = buildMockClient();
    await writeAuditEvent(
      {
        tenantId: "t-2",
        actor: "u-2",
        action: "x",
        outcome: "forbidden",
        occurredAtMs: Date.now(),
      },
      client,
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.target).toBeUndefined();
    expect(item.ipAddress).toBeUndefined();
    expect(item.userAgent).toBeUndefined();
    expect(item.extra).toBeUndefined();
  });

  it("extra が指定されると Item に含まれるべき (= 追加情報の保存)", async () => {
    const { client, send } = buildMockClient();
    await writeAuditEvent(
      {
        ...baseEvent,
        extra: { newRole: "TenantViewer", reason: "downgrade" },
      },
      client,
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.extra).toEqual({ newRole: "TenantViewer", reason: "downgrade" });
  });
});

describe("extractAuditContext (#950)", () => {
  it("HTTP API V2 形式 (= authorizer.jwt.claims) から actor / username / ipAddress / userAgent を抽出すべき", () => {
    const ctx = extractAuditContext({
      env: {
        event: {
          requestContext: {
            authorizer: {
              jwt: {
                claims: {
                  sub: "abc-123",
                  "cognito:username": "alice@example.com",
                },
              },
            },
            http: { sourceIp: "203.0.113.10", userAgent: "curl/8.0" },
          },
        },
      },
    });
    expect(ctx.actor).toBe("abc-123");
    expect(ctx.actorUsername).toBe("alice@example.com");
    expect(ctx.ipAddress).toBe("203.0.113.10");
    expect(ctx.userAgent).toBe("curl/8.0");
  });

  it("REST API 形式 (= authorizer.claims) でも actor が引けるべき", () => {
    const ctx = extractAuditContext({
      env: {
        event: {
          requestContext: {
            authorizer: { claims: { sub: "def-456" } },
          },
        },
      },
    });
    expect(ctx.actor).toBe("def-456");
  });

  it("claims 不在なら actor='unknown', 他は undefined", () => {
    const ctx = extractAuditContext({});
    expect(ctx.actor).toBe("unknown");
    expect(ctx.actorUsername).toBeUndefined();
    expect(ctx.ipAddress).toBeUndefined();
    expect(ctx.userAgent).toBeUndefined();
  });
});
