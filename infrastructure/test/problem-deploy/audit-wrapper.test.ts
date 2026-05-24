import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withAudit,
  withAuditSuccess,
} from "../../lib/problem-deploy/handlers/shared/audit/audit-wrapper";
import * as auditLog from "../../lib/problem-deploy/handlers/shared/audit-log";

/**
 * Issue #1292: withAudit / withAuditSuccess wrapper の挙動を pin する。
 *
 * - body() の success → outcome="success" の audit 行が書かれる
 * - body() throw → outcome="error" + errorMessage 付き audit 行が書かれて throw 再投
 * - audit 書き込みは fire-and-forget (= await しない、 route response が遅延しない)
 *
 * 実 DDB に触れず、 writeAuditEvent を spy で intercept する (= 既存 audit-log.test.ts と同方針)。
 */

const ORIGINAL_TABLE = process.env.ADMIN_AUDIT_LOG_TABLE_NAME;

function buildContext() {
  return {
    env: {
      event: {
        requestContext: {
          authorizer: {
            jwt: { claims: { sub: "u-1", "cognito:username": "alice@example.com" } },
          },
          http: { sourceIp: "203.0.113.5", userAgent: "Mozilla/5.0" },
        },
      },
    },
    req: { header: () => undefined },
  } as never;
}

let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditLog";
  writeSpy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
});

afterEach(() => {
  if (ORIGINAL_TABLE === undefined) delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
  else process.env.ADMIN_AUDIT_LOG_TABLE_NAME = ORIGINAL_TABLE;
  writeSpy.mockRestore();
  vi.clearAllMocks();
});

async function flushFireAndForget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withAuditSuccess (#1292)", () => {
  it("should emit a success audit row and return the body result", async () => {
    const ctx = buildContext();
    const result = await withAuditSuccess(
      ctx,
      {
        tenantId: "t-1",
        action: "create_event",
        resource: "event",
        target: "evt-1",
        after: { id: "evt-1", name: "Battle 1" },
      },
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    await flushFireAndForget();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const event = writeSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.action).toBe("create_event");
    expect(event.outcome).toBe("success");
    expect(event.actor).toBe("u-1");
    expect(event.actorUsername).toBe("alice@example.com");
    const extra = event.extra as Record<string, string>;
    expect(extra.resource).toBe("event");
    expect(extra.after).toBe(JSON.stringify({ id: "evt-1", name: "Battle 1" }));
  });

  it("should emit an error audit row and rethrow when body throws", async () => {
    const ctx = buildContext();
    const boom = new Error("kaboom");
    await expect(
      withAuditSuccess(
        ctx,
        { tenantId: "t-1", action: "delete_event", resource: "event", target: "evt-1" },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    await flushFireAndForget();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const event = writeSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.outcome).toBe("error");
    const extra = event.extra as Record<string, string>;
    expect(extra.errorMessage).toBe("kaboom");
  });
});

describe("withAudit (#1292)", () => {
  it("should respect the outcome chosen by body() and include diff extras", async () => {
    const ctx = buildContext();
    const result = await withAudit(
      ctx,
      {
        tenantId: "t-1",
        action: "patch_event",
        resource: "event",
        target: "evt-1",
        before: { name: "old", id: "evt-1" },
        after: { name: "new", id: "evt-1" },
      },
      async () => ({
        result: 42,
        audit: { outcome: "success" as const },
      }),
    );
    expect(result).toBe(42);
    await flushFireAndForget();
    const event = writeSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const extra = event.extra as Record<string, string>;
    expect(JSON.parse(extra.before)).toEqual({ name: "old" });
    expect(JSON.parse(extra.after)).toEqual({ name: "new" });
  });

  it("should NOT block the route when audit write fails (fire-and-forget)", async () => {
    const ctx = buildContext();
    writeSpy.mockRejectedValueOnce(new Error("ddb down"));
    const result = await withAuditSuccess(
      ctx,
      { tenantId: "t-1", action: "noop", resource: "event" },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});
