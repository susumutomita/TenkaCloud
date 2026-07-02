import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  removeProgressionGate,
  setProgressionGate,
} from "../../lib/problem-deploy/handlers/event-handler/progression-gate";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * Issue #2283: Progression Gate 設定 service 層。
 * cross-entity 検証 (Event 内問題 / 実在 team / feature flag) + 保存 / 除去を検証する。
 */

const send = vi.fn();
const shared = {
  ddb: { send },
  eventsTableName: "TestEvents",
  teamsTableName: "TestTeams",
} as unknown as EventSharedResources;

const NOW = 1_750_000_000_000;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const config = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle"],
  defaultPolicy: "required" as const,
  teamOverrides: { "team-1": { policy: "off" as const } },
};

const eventRow = {
  eventId: EVENT_ID,
  tenantId: "tenant-test",
  status: "READY",
  problems: [
    { problemId: "hello-world-battle", defaultRegion: "ap-northeast-1" },
    { problemId: "stackstack-battle", defaultRegion: "ap-northeast-1" },
  ],
};

/**
 * setProgressionGate の DDB 呼び出し順:
 *   1. GetCommand (tenant FLAGS 行)
 *   2. GetCommand (event META) + QueryCommand (teams) — Promise.all
 *   3. UpdateCommand (progressionGate SET)
 * command 種別 + Key で応答を切り替える。
 */
interface MockDdbOpts {
  flags?: Record<string, boolean>;
  event?: Record<string, unknown> | undefined;
  teamIds?: readonly string[];
  updateError?: Error;
}

/** command 種別 + Key ごとの成功応答 (updateError は closure 側で分岐)。 */
function ddbResponseFor(cmd: unknown, opts: MockDdbOpts): unknown {
  if (cmd instanceof GetCommand && cmd.input.Key?.SK === "FLAGS") {
    return { Item: opts.flags ? { flags: opts.flags } : undefined };
  }
  if (cmd instanceof GetCommand) return { Item: opts.event };
  if (cmd instanceof QueryCommand) {
    return { Items: (opts.teamIds ?? []).map((teamId) => ({ teamId })) };
  }
  if (cmd instanceof UpdateCommand) return { Attributes: {} };
  throw new Error(`unexpected command: ${String(cmd)}`);
}

function mockDdbFor(opts: MockDdbOpts) {
  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateCommand && opts.updateError) return Promise.reject(opts.updateError);
    return Promise.resolve(ddbResponseFor(cmd, opts));
  });
}

// resetAllMocks: mockImplementation / once キューまで毎テスト初期化する。 mockDdbFor (implementation)
// と removeProgressionGate 群の mockResolvedValueOnce が混在するため、 clear では実装が漏れる。
beforeEach(() => vi.resetAllMocks());

describe("setProgressionGate", () => {
  it("should reject with feature_disabled when the tenant flag is OFF (default)", async () => {
    mockDdbFor({ flags: {}, event: eventRow, teamIds: ["team-1"] });

    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);

    expect(outcome).toEqual({ kind: "feature_disabled" });
    // flag OFF なら event 行の Update は発行しない。
    const updates = send.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
    expect(updates).toHaveLength(0);
  });

  it("should save the config when the flag is ON and all references are valid", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: eventRow,
      teamIds: ["team-1", "team-2"],
    });

    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);

    expect(outcome).toEqual({ kind: "ok", progressionGate: config });
    const update = send.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.TableName).toBe("TestEvents");
    expect(update.input.Key).toEqual({ PK: `EVENT#${EVENT_ID}`, SK: "META" });
    expect(update.input.UpdateExpression).toContain("progressionGate = :cfg");
    expect(update.input.ConditionExpression).toBe("tenantId = :tenantId");
    expect(update.input.ExpressionAttributeValues?.[":cfg"]).toEqual(config);
  });

  it("should return not_found when the event does not exist", async () => {
    mockDdbFor({ flags: { challengePrerequisiteGate: true }, event: undefined });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("should return not_found when the event belongs to another tenant", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: { ...eventRow, tenantId: "other" },
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("should reject a gate problem that is not part of the event", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: { ...eventRow, problems: [{ problemId: "stackstack-battle" }] },
      teamIds: ["team-1"],
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "invalid", reason: "gate_problem_not_in_event" });
  });

  it("should reject an unlock target that is not part of the event", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: { ...eventRow, problems: [{ problemId: "hello-world-battle" }] },
      teamIds: ["team-1"],
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "invalid", reason: "unlock_target_not_in_event" });
  });

  it("should reject a team override for a team that does not exist in the event", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: eventRow,
      teamIds: ["someone-else"],
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "invalid", reason: "unknown_override_team" });
  });

  it("should reject configuring an archived event", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: { ...eventRow, status: "ARCHIVED" },
      teamIds: ["team-1"],
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "invalid", reason: "event_archived" });
  });

  it("should return not_found when the write loses a race (event deleted / tenant changed)", async () => {
    const err = new Error("cond");
    err.name = "ConditionalCheckFailedException";
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: eventRow,
      teamIds: ["team-1"],
      updateError: err,
    });
    const outcome = await setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW);
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("should rethrow a non-conditional write failure", async () => {
    mockDdbFor({
      flags: { challengePrerequisiteGate: true },
      event: eventRow,
      teamIds: ["team-1"],
      updateError: new Error("ddb boom"),
    });
    await expect(setProgressionGate(shared, "tenant-test", EVENT_ID, config, NOW)).rejects.toThrow(
      "ddb boom",
    );
  });
});

describe("removeProgressionGate", () => {
  it("should remove the config and report removed=true when one existed", async () => {
    send.mockResolvedValueOnce({ Attributes: { progressionGate: config } });

    const outcome = await removeProgressionGate(shared, "tenant-test", EVENT_ID, NOW);

    expect(outcome).toEqual({ kind: "ok", removed: true });
    const update = send.mock.calls[0]?.[0] as UpdateCommand;
    expect(update.input.UpdateExpression).toContain("REMOVE progressionGate");
    expect(update.input.ConditionExpression).toBe("tenantId = :tenantId");
  });

  it("should be idempotent (removed=false) when no config was stored", async () => {
    send.mockResolvedValueOnce({ Attributes: { eventId: EVENT_ID } });
    const outcome = await removeProgressionGate(shared, "tenant-test", EVENT_ID, NOW);
    expect(outcome).toEqual({ kind: "ok", removed: false });
  });

  it("should return not_found when the condition fails (missing row / other tenant)", async () => {
    const err = new Error("cond");
    err.name = "ConditionalCheckFailedException";
    send.mockRejectedValueOnce(err);
    const outcome = await removeProgressionGate(shared, "tenant-test", EVENT_ID, NOW);
    expect(outcome).toEqual({ kind: "not_found" });
  });
});
