/**
 * Issue #2019: unit tests for the deploy-side enforcement glue
 * (`cloud-action-enforcement.ts`). The pure verdict logic is covered 100% in
 * `packages/trust-bridge`; here we cover the env parsing, policy assembly, and
 * the paginated replacement lookup.
 */

import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  buildCloudActionPolicy,
  evaluateDeployGate,
  holdForApproval,
  parseEnforcementMode,
} from "../../lib/problem-deploy/handlers/deploy-handler/cloud-action-enforcement";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

describe("parseEnforcementMode", () => {
  it("should parse 'enforce' (case / whitespace insensitive)", () => {
    expect(parseEnforcementMode("enforce")).toBe("enforce");
    expect(parseEnforcementMode("  ENFORCE ")).toBe("enforce");
  });

  it("should default to shadow for unset / empty / unknown values", () => {
    expect(parseEnforcementMode(undefined)).toBe("shadow");
    expect(parseEnforcementMode("")).toBe("shadow");
    expect(parseEnforcementMode("shadow")).toBe("shadow");
    expect(parseEnforcementMode("bogus")).toBe("shadow");
  });
});

describe("buildCloudActionPolicy", () => {
  it("should carry the mode and the first gated high-risk rule", () => {
    const policy = buildCloudActionPolicy("enforce");
    expect(policy.enforcementMode).toBe("enforce");
    expect(policy.requireApprovalFor).toEqual([
      { actionType: "deploy", conditions: { replacesExistingStack: true } },
    ]);
  });
});

describe("evaluateDeployGate", () => {
  const deps = (send: ReturnType<typeof vi.fn>) => ({
    runtime: makeTestControlDataRuntime(),
    ddb: { send } as never,
    tableName: "T",
  });

  const SELF = "01HSELF";

  it("should allow without any DDB I/O in shadow mode", async () => {
    const send = vi.fn();
    const outcome = await evaluateDeployGate({
      mode: "shadow",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    expect(outcome.verdict).toBe("allow");
    expect(send).not.toHaveBeenCalled();
  });

  it("should hold (needs_approval) in enforce mode when ANOTHER live stack shares the namePrefix", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ namePrefix: "tc-x-y", jobId: "01HOTHER", status: "COMPLETE" }],
    });
    const outcome = await evaluateDeployGate({
      mode: "enforce",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    expect(outcome.verdict).toBe("needs_approval");
    expect(outcome.context.replacesExistingStack).toBe(true);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  });

  it("should NOT hold on the deploy's OWN just-written PENDING row (self-match excluded)", async () => {
    // The own row (same jobId, PENDING, same namePrefix) is written before the
    // gate runs and is visible to GSI1; it must NOT count as a replacement.
    const send = vi
      .fn()
      .mockResolvedValue({ Items: [{ namePrefix: "tc-x-y", jobId: SELF, status: "PENDING" }] });
    const outcome = await evaluateDeployGate({
      mode: "enforce",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    expect(outcome.verdict).toBe("allow");
    expect(outcome.context.replacesExistingStack).toBe(false);
  });

  it("should allow in enforce mode when only FAILED / deleted prior rows exist", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { namePrefix: "tc-x-y", jobId: "01HA", status: "FAILED" },
        { namePrefix: "tc-x-y", jobId: "01HB", status: "AUTO_DELETED" },
      ],
    });
    const outcome = await evaluateDeployGate({
      mode: "enforce",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    expect(outcome.verdict).toBe("allow");
    expect(outcome.context.replacesExistingStack).toBe(false);
  });

  it("should drain all GSI1 pages before concluding there is no replacement", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ namePrefix: "tc-x-y", jobId: "01HA", status: "FAILED" }],
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({
        Items: [{ namePrefix: "tc-x-y", jobId: "01HB", status: "IN_PROGRESS" }],
      });
    const outcome = await evaluateDeployGate({
      mode: "enforce",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    // A live row on the SECOND page must still be found.
    expect(outcome.verdict).toBe("needs_approval");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("should treat an empty result as no replacement (allow)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const outcome = await evaluateDeployGate({
      mode: "enforce",
      deps: deps(send),
      tenantId: "t",
      namePrefix: "tc-x-y",
      jobId: SELF,
    });
    expect(outcome.verdict).toBe("allow");
    expect(outcome.context.replacesExistingStack).toBe(false);
  });
});

describe("holdForApproval", () => {
  it("should conditionally flip PENDING → APPROVAL_PENDING for our own tenant row", async () => {
    const send = vi.fn().mockResolvedValue({});
    await holdForApproval({
      runtime: makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "T",
      jobId: "01HX",
      tenantId: "tenant-acme",
      nowIso: "2026-06-24T00:00:00.000Z",
    });
    const cmd = send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.Key).toEqual({ PK: "DEPLOYMENT#01HX", SK: "META" });
    expect(cmd.input.ConditionExpression).toBe("tenantId = :tenantId AND #s = :pending");
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({
      ":approvalPending": "APPROVAL_PENDING",
      ":pending": "PENDING",
      ":tenantId": "tenant-acme",
      ":updatedAt": "2026-06-24T00:00:00.000Z",
    });
  });
});
