import { describe, expect, it, vi } from "vitest";
import { MANAGED_BY_ALWAYS_ON_RUNTIME } from "../../../lib/always-on-runtime/runtime-tags";
import {
  type CfnStacksClient,
  DEFAULT_MAX_ATTEMPTS,
  type IssueFiler,
  type ManagedStack,
  sweepExpiredRuntimes,
} from "../../../lib/always-on-runtime/sweeper/sweep";

const NOW = new Date("2026-07-03T00:00:00.000Z");
const PAST = "2026-07-01T00:00:00.000Z";
const FUTURE = "2026-07-05T00:00:00.000Z";

const alwaysOn = (stackName: string, expiresAt?: string): ManagedStack => ({
  stackName,
  managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME,
  eventId: `event-${stackName}`,
  archiveFunctionName: `archive-${stackName}`,
  ...(expiresAt !== undefined ? { expiresAt } : {}),
});

/** Build a fake CloudFormation edge from a stack list + a per-stack delete implementation. */
function fakeStacks(
  list: readonly ManagedStack[],
  deleteStack: CfnStacksClient["deleteStack"],
  archiveStack: CfnStacksClient["archiveStack"] = vi.fn(async () => {}),
): CfnStacksClient {
  return { listManagedStacks: async () => list, deleteStack, archiveStack };
}

function fakeIssues(): IssueFiler & { openCleanupFailureIssue: ReturnType<typeof vi.fn> } {
  return { openCleanupFailureIssue: vi.fn(async () => {}) };
}

describe("sweepExpiredRuntimes", () => {
  it("should delete only expired always-on-runtime stacks", async () => {
    const deleteStack = vi.fn(async () => {});
    const issues = fakeIssues();
    const stacks = fakeStacks(
      [alwaysOn("expired-a", PAST), alwaysOn("future-b", FUTURE)],
      deleteStack,
    );

    const summary = await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 3 }, NOW);

    expect(deleteStack).toHaveBeenCalledTimes(1);
    expect(deleteStack).toHaveBeenCalledWith("expired-a");
    expect(issues.openCleanupFailureIssue).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 2, expired: 1, deleted: 1, failed: 0 });
  });

  it("should refuse deletion and file an issue when the raw score archive fails", async () => {
    const deleteStack = vi.fn(async () => {});
    const archiveStack = vi.fn(async () => {
      throw new Error("archive bucket unavailable");
    });
    const issues = fakeIssues();
    const stacks = fakeStacks([alwaysOn("expired", PAST)], deleteStack, archiveStack);

    const summary = await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 2 }, NOW);

    expect(archiveStack).toHaveBeenCalledTimes(2);
    expect(deleteStack).not.toHaveBeenCalled();
    expect(issues.openCleanupFailureIssue).toHaveBeenCalledWith({
      stackName: "expired",
      attempts: 2,
      lastError: "archive failed: archive bucket unavailable",
    });
    expect(summary).toEqual({ scanned: 1, expired: 1, deleted: 0, failed: 1 });
  });

  it("should never delete a non-expired or non-always-on-runtime stack", async () => {
    const deleteStack = vi.fn(async () => {});
    const issues = fakeIssues();
    const stacks = fakeStacks(
      [
        alwaysOn("future", FUTURE), // always-on but not yet expired
        { stackName: "lite-past", managedBy: "lite", expiresAt: PAST }, // wrong ManagedBy
        { stackName: "untagged-past", expiresAt: PAST }, // no ManagedBy tag at all
        alwaysOn("no-expiry"), // always-on but ExpiresAt absent
        alwaysOn("bad-expiry", "not-a-date"), // always-on but ExpiresAt unparseable
      ],
      deleteStack,
    );

    const summary = await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 3 }, NOW);

    expect(deleteStack).not.toHaveBeenCalled();
    expect(issues.openCleanupFailureIssue).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 5, expired: 0, deleted: 0, failed: 0 });
  });

  it("should file exactly one issue naming a stack that fails every retry", async () => {
    const deleteStack = vi.fn(async () => {
      throw new Error("boom");
    });
    const issues = fakeIssues();
    const stacks = fakeStacks([alwaysOn("stuck", PAST)], deleteStack);

    const summary = await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 3 }, NOW);

    expect(deleteStack).toHaveBeenCalledTimes(3);
    expect(issues.openCleanupFailureIssue).toHaveBeenCalledTimes(1);
    expect(issues.openCleanupFailureIssue).toHaveBeenCalledWith({
      stackName: "stuck",
      attempts: 3,
      lastError: "boom",
    });
    expect(summary).toEqual({ scanned: 1, expired: 1, deleted: 0, failed: 1 });
  });

  it("should stringify a non-Error rejection in the filed issue", async () => {
    const deleteStack = vi.fn().mockRejectedValue("kaboom-string");
    const issues = fakeIssues();
    const stacks = fakeStacks([alwaysOn("stuck", PAST)], deleteStack);

    await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 2 }, NOW);

    expect(issues.openCleanupFailureIssue).toHaveBeenCalledWith({
      stackName: "stuck",
      attempts: 2,
      lastError: "kaboom-string",
    });
  });

  it("should not report a stack that succeeds on retry as failed", async () => {
    const deleteStack = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const issues = fakeIssues();
    const stacks = fakeStacks([alwaysOn("flaky", PAST)], deleteStack);

    const summary = await sweepExpiredRuntimes({ stacks, issues, maxAttempts: 3 }, NOW);

    expect(deleteStack).toHaveBeenCalledTimes(2);
    expect(issues.openCleanupFailureIssue).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, expired: 1, deleted: 1, failed: 0 });
  });

  it("should return accurate summary counts across mixed stacks using the default retry budget", async () => {
    const deleteStack = vi.fn(async (stackName: string) => {
      if (stackName === "expired-stuck") throw new Error("nope");
    });
    const issues = fakeIssues();
    const stacks = fakeStacks(
      [
        alwaysOn("expired-ok", PAST),
        alwaysOn("expired-stuck", PAST),
        alwaysOn("future", FUTURE),
        { stackName: "lite", managedBy: "lite", expiresAt: PAST },
      ],
      deleteStack,
    );

    const summary = await sweepExpiredRuntimes({ stacks, issues }, NOW);

    // "expired-ok" deletes in one call; "expired-stuck" burns the full default budget.
    expect(deleteStack).toHaveBeenCalledTimes(1 + DEFAULT_MAX_ATTEMPTS);
    expect(issues.openCleanupFailureIssue).toHaveBeenCalledTimes(1);
    expect(issues.openCleanupFailureIssue).toHaveBeenCalledWith({
      stackName: "expired-stuck",
      attempts: DEFAULT_MAX_ATTEMPTS,
      lastError: "nope",
    });
    expect(summary).toEqual({ scanned: 4, expired: 2, deleted: 1, failed: 1 });
  });

  it("should propagate a listing failure loudly instead of swallowing it", async () => {
    const issues = fakeIssues();
    const stacks: CfnStacksClient = {
      listManagedStacks: async () => {
        throw new Error("cfn describe-stacks failed");
      },
      deleteStack: vi.fn(async () => {}),
      archiveStack: vi.fn(async () => {}),
    };

    await expect(sweepExpiredRuntimes({ stacks, issues }, NOW)).rejects.toThrow(
      "cfn describe-stacks failed",
    );
    expect(issues.openCleanupFailureIssue).not.toHaveBeenCalled();
  });
});
