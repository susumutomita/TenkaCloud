import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditClient,
  extractAuditContext,
  isAuditLoggingEnabled,
  resolveAuditRetentionDays,
  SOC2_AUDIT_RETENTION_DAYS,
  writeAuditEvent,
} from "../../lib/problem-deploy/handlers/shared/audit-log";

/**
 * Issue #950: writeAuditEvent helper の挙動を pin する。
 *
 * - env ADMIN_AUDIT_LOG_TABLE_NAME が空文字 → no-op で false を返すべき (= 旧 stack 互換)
 * - env 設定済 + 正常書き込み → PutCommand を送信して true を返すべき
 * - DDB 例外 → console.error で警告のみ、 false を返す (= caller の business logic を阻害しない)
 * - tenantId="SYSTEM" は PK="SYSTEM#<env>" に変換されるべき
 */

const ORIGINAL_TABLE = process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
const ORIGINAL_ENV = process.env.DEPLOY_ENVIRONMENT;
const ORIGINAL_RETENTION = process.env.AUDIT_RETENTION_DAYS;
const ORIGINAL_AUDIT_ENABLED = process.env.AUDIT_LOG_ENABLED;
beforeEach(() => {
  process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditLog";
  process.env.DEPLOY_ENVIRONMENT = "test-env";
  delete process.env.AUDIT_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_ENABLED;
});
afterEach(() => {
  if (ORIGINAL_TABLE === undefined) delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
  else process.env.ADMIN_AUDIT_LOG_TABLE_NAME = ORIGINAL_TABLE;
  if (ORIGINAL_ENV === undefined) delete process.env.DEPLOY_ENVIRONMENT;
  else process.env.DEPLOY_ENVIRONMENT = ORIGINAL_ENV;
  if (ORIGINAL_RETENTION === undefined) delete process.env.AUDIT_RETENTION_DAYS;
  else process.env.AUDIT_RETENTION_DAYS = ORIGINAL_RETENTION;
  if (ORIGINAL_AUDIT_ENABLED === undefined) delete process.env.AUDIT_LOG_ENABLED;
  else process.env.AUDIT_LOG_ENABLED = ORIGINAL_AUDIT_ENABLED;
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
  it("should send PutCommand and return true when env is wired", async () => {
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
    // ttl = occurredAtMs/1000 + 90*86400 (= default OSS retention; Issue #1341)
    expect(item.ttl).toBe(Math.floor(baseEvent.occurredAtMs / 1000) + 90 * 86400);
  });

  it("should use 365-day TTL when AUDIT_RETENTION_DAYS=365 (Issue #1341 SOC2)", async () => {
    process.env.AUDIT_RETENTION_DAYS = "365";
    const { client, send } = buildMockClient();
    await writeAuditEvent(baseEvent, client);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.ttl).toBe(Math.floor(baseEvent.occurredAtMs / 1000) + 365 * 86400);
  });

  it("should fall back to 90 days for invalid AUDIT_RETENTION_DAYS values", async () => {
    process.env.AUDIT_RETENTION_DAYS = "not-a-number";
    const { client, send } = buildMockClient();
    await writeAuditEvent(baseEvent, client);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.ttl).toBe(Math.floor(baseEvent.occurredAtMs / 1000) + 90 * 86400);
  });

  it("should noop and return false when env is empty (legacy stack compat)", async () => {
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
    const { client, send } = buildMockClient();
    const ok = await writeAuditEvent(baseEvent, client);
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("should noop and return false when AUDIT_LOG_ENABLED=false (#2311 cost toggle)", async () => {
    // feature flag off → table 配線があっても 1 write も出さない (= write cost 節約)。
    process.env.AUDIT_LOG_ENABLED = "false";
    const { client, send } = buildMockClient();
    const ok = await writeAuditEvent(baseEvent, client);
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("should still write when AUDIT_LOG_ENABLED=true (explicit on)", async () => {
    process.env.AUDIT_LOG_ENABLED = "true";
    const { client, send } = buildMockClient();
    const ok = await writeAuditEvent(baseEvent, client);
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("DDB 例外なら false を返して console.error を出し、 throw しない", async () => {
    const send = vi.fn().mockRejectedValue(new Error("DDB failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok = await writeAuditEvent(baseEvent, { send: send as never });
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("should convert tenantId='SYSTEM' to PK='SYSTEM#<env>'", async () => {
    const { client, send } = buildMockClient();
    await writeAuditEvent({ ...baseEvent, tenantId: "SYSTEM" }, client);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    const item = cmd.input?.Item as Record<string, unknown>;
    expect(item.PK).toBe("SYSTEM#test-env");
  });

  it("should skip optional fields (target / ipAddress / userAgent / extra) when undefined", async () => {
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

  it("should include extra in the Item when specified (preserves extra info)", async () => {
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

describe("resolveAuditRetentionDays (#1341)", () => {
  it("should default to 90 when env is unset", () => {
    delete process.env.AUDIT_RETENTION_DAYS;
    expect(resolveAuditRetentionDays()).toBe(90);
  });

  it("should accept 365 for SOC2 enterprise hosted", () => {
    process.env.AUDIT_RETENTION_DAYS = "365";
    expect(resolveAuditRetentionDays()).toBe(365);
    expect(SOC2_AUDIT_RETENTION_DAYS).toBe(365);
  });

  it("should clamp values larger than 3650 (= 10 years)", () => {
    process.env.AUDIT_RETENTION_DAYS = "9999";
    expect(resolveAuditRetentionDays()).toBe(3650);
  });

  it("should reject negative or zero values and fall back to 90", () => {
    process.env.AUDIT_RETENTION_DAYS = "-30";
    expect(resolveAuditRetentionDays()).toBe(90);
    process.env.AUDIT_RETENTION_DAYS = "0";
    expect(resolveAuditRetentionDays()).toBe(90);
  });
});

describe("isAuditLoggingEnabled (#2311)", () => {
  it("should default to enabled when AUDIT_LOG_ENABLED is unset (no regression)", () => {
    delete process.env.AUDIT_LOG_ENABLED;
    expect(isAuditLoggingEnabled()).toBe(true);
  });

  it("should be enabled for AUDIT_LOG_ENABLED='true'", () => {
    process.env.AUDIT_LOG_ENABLED = "true";
    expect(isAuditLoggingEnabled()).toBe(true);
  });

  it("should be disabled only for the exact string 'false'", () => {
    process.env.AUDIT_LOG_ENABLED = "false";
    expect(isAuditLoggingEnabled()).toBe(false);
  });

  it("should treat any non-'false' value as enabled (fail-safe toward keeping the trail)", () => {
    // 設定ミス (例: "0" / "off") で意図せず audit が消えるより、 明示 "false" のみ無効化する。
    process.env.AUDIT_LOG_ENABLED = "0";
    expect(isAuditLoggingEnabled()).toBe(true);
  });
});

describe("extractAuditContext (#950)", () => {
  it("should extract actor / username / ipAddress / userAgent from HTTP API V2 form (authorizer.jwt.claims)", () => {
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

  it("should extract actor + ipAddress + userAgent from REST API V1 form (authorizer.claims + identity.*)", () => {
    // REST API v1 (= tenant API) は IP を requestContext.identity.* に置く。 旧実装は v2 の
    // http.* しか読まず IP が常に "-" になっていた regression を pin する。
    const ctx = extractAuditContext({
      env: {
        event: {
          requestContext: {
            authorizer: { claims: { sub: "def-456", "cognito:username": "bob@example.com" } },
            identity: { sourceIp: "198.51.100.7", userAgent: "Mozilla/5.0" },
          },
        },
      },
    });
    expect(ctx.actor).toBe("def-456");
    expect(ctx.actorUsername).toBe("bob@example.com");
    expect(ctx.ipAddress).toBe("198.51.100.7");
    expect(ctx.userAgent).toBe("Mozilla/5.0");
  });

  it("claims 不在なら actor='unknown', 他は undefined", () => {
    const ctx = extractAuditContext({});
    expect(ctx.actor).toBe("unknown");
    expect(ctx.actorUsername).toBeUndefined();
    expect(ctx.ipAddress).toBeUndefined();
    expect(ctx.userAgent).toBeUndefined();
  });
});
