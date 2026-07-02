import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GateCompletionCache,
  isLockedForScoring,
  maybeLatchGateCompletion,
  type TenantFlagCache,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/gate-completion-bonus";

/**
 * Issue #2283: scoring tick 側の Progression Gate 処理。
 *   - 完了 latch (gateCompletedAt) が one-time で書かれる
 *   - 完了 bonus が 1 TransactWrite (score ADD + gate-bonus event) で 1 回だけ付く
 *   - locked unlock target の polling 採点が skip される
 */

const send = vi.fn();
const shared = {
  ddb: { send } as unknown as DynamoDBDocumentClient,
  deploymentsTableName: "TestDeployments",
  eventsTableName: "TestEvents",
};

const NOW = "2026-07-02T00:00:00.000Z";

const config = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle"],
  defaultPolicy: "required" as const,
  teamOverrides: {
    "team-beginner": { policy: "required" as const, completionBonus: 300 },
    "team-nobonus": { policy: "required" as const },
    "team-adv": { policy: "off" as const },
  },
};

const gateItem = (over: Partial<Record<string, unknown>> = {}) => ({
  PK: "DEPLOYMENT#job-gate",
  jobId: "job-gate",
  problemId: "hello-world-battle",
  tenantId: "tenant-test",
  teamId: "team-beginner",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  expiresAt: 1234,
  score: 100,
  ...over,
});

const targetItem = (over: Partial<Record<string, unknown>> = {}) => ({
  PK: "DEPLOYMENT#job-target",
  jobId: "job-target",
  problemId: "stackstack-battle",
  tenantId: "tenant-test",
  teamId: "team-beginner",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  GSI2PK: "TEAMKEY#abc",
  status: "COMPLETE",
  expiresAt: 1234,
  ...over,
});

function mockDdb(opts: { flagEnabled?: boolean; gateRowScore?: number } = {}) {
  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      return Promise.resolve({
        Item: { flags: { challengePrerequisiteGate: opts.flagEnabled !== false } },
      });
    }
    if (cmd instanceof QueryCommand) {
      // GSI2 team query (isLockedForScoring の gate 完了判定)。
      return Promise.resolve({
        Items: [gateItem({ score: opts.gateRowScore ?? 0 }), targetItem()],
      });
    }
    if (cmd instanceof UpdateCommand) return Promise.resolve({ Attributes: {} });
    if (cmd instanceof TransactWriteCommand) return Promise.resolve({});
    throw new Error("unexpected command");
  });
}

const freshFlagCache = (): TenantFlagCache => new Map();
const freshCompletionCache = (): GateCompletionCache => new Map();

beforeEach(() => vi.clearAllMocks());

describe("maybeLatchGateCompletion", () => {
  it("should latch gateCompletedAt once and award the bonus in a single transaction", async () => {
    mockDdb();

    await maybeLatchGateCompletion(shared, gateItem(), config, NOW, freshFlagCache());

    const latch = send.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof UpdateCommand) as UpdateCommand;
    expect(latch.input.UpdateExpression).toContain("gateCompletedAt = :now");
    expect(latch.input.ConditionExpression).toBe("attribute_not_exists(gateCompletedAt)");

    const transact = send.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof TransactWriteCommand) as TransactWriteCommand;
    const [update, put] = transact.input.TransactItems ?? [];
    expect(update?.Update?.UpdateExpression).toContain("ADD score :bonus");
    expect(update?.Update?.ConditionExpression).toBe("attribute_not_exists(gateBonusAwardedAt)");
    expect(update?.Update?.ExpressionAttributeValues?.[":bonus"]).toBe(300);
    expect(put?.Put?.Item).toMatchObject({
      source: "gate-bonus",
      points: 300,
      result: "ok",
      problemId: "hello-world-battle",
      teamId: "team-beginner",
    });
  });

  it("should skip the latch write when gateCompletedAt is already recorded", async () => {
    mockDdb();

    await maybeLatchGateCompletion(
      shared,
      gateItem({ gateCompletedAt: NOW, gateBonusAwardedAt: NOW }),
      config,
      NOW,
      freshFlagCache(),
    );

    expect(send).not.toHaveBeenCalled();
  });

  it("should not touch DDB when the gate is not completed yet (score 0, no flag)", async () => {
    mockDdb();
    await maybeLatchGateCompletion(
      shared,
      gateItem({ score: 0, flagSubmitted: undefined }),
      config,
      NOW,
      freshFlagCache(),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("should latch and award for a flag-kind gate via flagSubmitted at score 0", async () => {
    mockDdb();
    await maybeLatchGateCompletion(
      shared,
      gateItem({ score: 0, flagSubmitted: true }),
      config,
      NOW,
      freshFlagCache(),
    );
    expect(send.mock.calls.some(([cmd]) => cmd instanceof TransactWriteCommand)).toBe(true);
  });

  it("should still latch completion but skip the bonus when the tenant flag is OFF", async () => {
    mockDdb({ flagEnabled: false });

    await maybeLatchGateCompletion(shared, gateItem(), config, NOW, freshFlagCache());

    expect(send.mock.calls.some(([cmd]) => cmd instanceof UpdateCommand)).toBe(true);
    expect(send.mock.calls.some(([cmd]) => cmd instanceof TransactWriteCommand)).toBe(false);
  });

  it("should not award when the team has no completionBonus configured", async () => {
    mockDdb();
    await maybeLatchGateCompletion(
      shared,
      gateItem({ teamId: "team-nobonus", gateCompletedAt: NOW }),
      config,
      NOW,
      freshFlagCache(),
    );
    expect(send.mock.calls.some(([cmd]) => cmd instanceof TransactWriteCommand)).toBe(false);
  });

  it("should treat a canceled transaction (already awarded / transient) as a no-op", async () => {
    send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({ Item: { flags: { challengePrerequisiteGate: true } } });
      }
      if (cmd instanceof UpdateCommand) return Promise.resolve({ Attributes: {} });
      if (cmd instanceof TransactWriteCommand) {
        const err = new Error("canceled");
        err.name = "TransactionCanceledException";
        return Promise.reject(err);
      }
      throw new Error("unexpected command");
    });

    await expect(
      maybeLatchGateCompletion(shared, gateItem(), config, NOW, freshFlagCache()),
    ).resolves.toBeUndefined();
  });

  it("should ignore non-gate problems and missing config", async () => {
    mockDdb();
    await maybeLatchGateCompletion(
      shared,
      gateItem({ problemId: "stackstack-battle" }),
      config,
      NOW,
      freshFlagCache(),
    );
    await maybeLatchGateCompletion(shared, gateItem(), undefined, NOW, freshFlagCache());
    expect(send).not.toHaveBeenCalled();
  });

  it("should read the tenant flag once per tick via the cache", async () => {
    mockDdb();
    const cache = freshFlagCache();

    await maybeLatchGateCompletion(shared, gateItem({ gateCompletedAt: NOW }), config, NOW, cache);
    await maybeLatchGateCompletion(
      shared,
      gateItem({ PK: "DEPLOYMENT#job-2", jobId: "job-2", gateCompletedAt: NOW }),
      config,
      NOW,
      cache,
    );

    const flagReads = send.mock.calls.filter(([cmd]) => cmd instanceof GetCommand);
    expect(flagReads).toHaveLength(1);
  });
});

describe("isLockedForScoring", () => {
  it("should skip scoring for a locked unlock target of a required team", async () => {
    mockDdb({ gateRowScore: 0 });

    const locked = await isLockedForScoring(
      shared,
      targetItem(),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(true);
  });

  it("should keep scoring the target once the team's gate row is completed", async () => {
    mockDdb({ gateRowScore: 100 });

    const locked = await isLockedForScoring(
      shared,
      targetItem(),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(false);
  });

  it("should keep scoring the target after a completed gate is torn down (latch on DELETED row)", async () => {
    // GSI2 query が live 行を返さず、 完了済 Gate の DELETED 行 (gateCompletedAt 済) だけを返す状態。
    // durable latch を拾って完了扱いにし、 unlock target の採点を再 lock しない。
    send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({ Item: { flags: { challengePrerequisiteGate: true } } });
      }
      if (cmd instanceof QueryCommand) {
        return Promise.resolve({
          Items: [gateItem({ status: "DELETED", score: 0, gateCompletedAt: NOW }), targetItem()],
        });
      }
      throw new Error("unexpected command");
    });

    const locked = await isLockedForScoring(
      shared,
      targetItem(),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(false);
  });

  it("should not skip when the tenant flag is OFF (default)", async () => {
    mockDdb({ flagEnabled: false, gateRowScore: 0 });

    const locked = await isLockedForScoring(
      shared,
      targetItem(),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(false);
    // flag OFF なら GSI2 query も発生しない。
    expect(send.mock.calls.some(([cmd]) => cmd instanceof QueryCommand)).toBe(false);
  });

  it("should not skip for a team whose policy override is off", async () => {
    mockDdb({ gateRowScore: 0 });

    const locked = await isLockedForScoring(
      shared,
      targetItem({ teamId: "team-adv" }),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("should not skip non-target problems or events without a gate config", async () => {
    mockDdb({ gateRowScore: 0 });

    expect(
      await isLockedForScoring(
        shared,
        targetItem({ problemId: "hello-world-battle" }),
        config,
        freshFlagCache(),
        freshCompletionCache(),
      ),
    ).toBe(false);
    expect(
      await isLockedForScoring(
        shared,
        targetItem(),
        undefined,
        freshFlagCache(),
        freshCompletionCache(),
      ),
    ).toBe(false);
  });

  it("should query the team's gate completion once per (event, team) via the cache", async () => {
    mockDdb({ gateRowScore: 0 });
    const flagCache = freshFlagCache();
    const completionCache = freshCompletionCache();

    await isLockedForScoring(shared, targetItem(), config, flagCache, completionCache);
    await isLockedForScoring(
      shared,
      targetItem({ PK: "DEPLOYMENT#job-target2", jobId: "job-target2" }),
      config,
      flagCache,
      completionCache,
    );

    const teamQueries = send.mock.calls.filter(([cmd]) => cmd instanceof QueryCommand);
    expect(teamQueries).toHaveLength(1);
  });

  it("should treat an unresolvable team (no GSI2PK) as locked (fail-closed: no scoring)", async () => {
    mockDdb({ gateRowScore: 100 });

    const locked = await isLockedForScoring(
      shared,
      targetItem({ GSI2PK: undefined }),
      config,
      freshFlagCache(),
      freshCompletionCache(),
    );

    expect(locked).toBe(true);
  });
});
