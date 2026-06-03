import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [#950 follow-up] auditEventAction: event-handler の mutating route が admin 監査行を残す helper。
 * writeAuditEvent / resolveTenantId を mock し、 emit される envelope を pin する。
 */

const { mockWrite } = vi.hoisted(() => ({ mockWrite: vi.fn() }));

vi.mock("../../lib/problem-deploy/handlers/shared/audit-log", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/problem-deploy/handlers/shared/audit-log")>();
  return { ...actual, writeAuditEvent: mockWrite };
});

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/auth", () => ({
  resolveTenantId: () => "tenant-x",
}));

import { auditEventAction } from "../../lib/problem-deploy/handlers/event-handler/audit";

function ctxWith(
  claims: Record<string, unknown>,
  http?: { sourceIp?: string; userAgent?: string },
) {
  return {
    env: { event: { requestContext: { authorizer: { jwt: { claims } }, http } } },
  } as unknown as Context;
}

describe("auditEventAction (#950 follow-up)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should emit a success audit envelope with tenant, actor, action, and target", () => {
    auditEventAction(
      ctxWith(
        { sub: "user-1", "cognito:username": "op@example.com" },
        { sourceIp: "1.2.3.4", userAgent: "UA/1" },
      ),
      "create_event",
      "EVT123",
    );
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-x",
      actor: "user-1",
      actorUsername: "op@example.com",
      action: "create_event",
      outcome: "success",
      target: "EVT123",
      ipAddress: "1.2.3.4",
      userAgent: "UA/1",
    });
    expect(typeof mockWrite.mock.calls[0][0].occurredAtMs).toBe("number");
  });

  it("should omit actorUsername / ipAddress / userAgent when the JWT/context lacks them", () => {
    auditEventAction(ctxWith({ sub: "user-2" }), "end_event", "EVT9");
    const env = mockWrite.mock.calls[0][0];
    expect(env).toMatchObject({ actor: "user-2", action: "end_event", target: "EVT9" });
    expect(env).not.toHaveProperty("actorUsername");
    expect(env).not.toHaveProperty("ipAddress");
    expect(env).not.toHaveProperty("userAgent");
  });

  it("should honor a non-success outcome", () => {
    auditEventAction(ctxWith({ sub: "user-3" }), "delete_event", "EVT1", "forbidden");
    expect(mockWrite.mock.calls[0][0].outcome).toBe("forbidden");
  });

  it("should default actor to 'unknown' when no JWT claims are present", () => {
    auditEventAction({ env: {} } as unknown as Context, "bulk_deploy", "EVT2");
    expect(mockWrite.mock.calls[0][0].actor).toBe("unknown");
  });
});
