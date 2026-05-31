import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireDisruption } from "../../lib/problem-deploy/handlers/event-handler/disruption-fire";
import type { DisruptionFireInput } from "../../lib/problem-deploy/handlers/event-handler/disruption-types";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * Issue #1418: fireDisruption (disruption-fire.ts の mutation 経路) を pin する。 catalog/declaration
 * 解決、 parameter allow-list、 scope 解決 (all/team/random-n)、 no_targets / invalid_scope、
 * idempotency claim (claimed / duplicate)、 publish 失敗 throw、 ok を網羅する。
 *
 * ddb は command + PK prefix で出し分ける fake、 events (EventBridge) は別 mock。
 */
const ccf = () => new ConditionalCheckFailedException({ $metadata: {}, message: "ccf" });
const cfg = {
  teams: [] as { teamId: string }[] | undefined,
  claimCcf: false,
  claimError: undefined as unknown,
  duplicateRow: undefined as Record<string, unknown> | undefined,
};
const eventsSend = vi.fn();
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command + PK.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof QueryCommand) return { Items: cfg.teams }; // listTeamsByEvent
    if (cmd instanceof GetCommand) return { Item: cfg.duplicateRow }; // getDuplicateDisruption
    if (cmd instanceof PutCommand) {
      const pk = String(cmd.input.Item?.PK ?? "");
      if (pk.startsWith("REQUEST#")) {
        if (cfg.claimError) throw cfg.claimError; // non-CCF claim error
        if (cfg.claimCcf) throw ccf(); // idempotency claim contended
        return {};
      }
      return {}; // AUDIT# put
    }
    return {};
  }),
};
const shared = {
  ddb,
  events: { send: eventsSend },
  eventBusName: "bus",
  teamsTableName: "Teams",
  disruptionsTableName: "Disruptions",
  problemsDisruptions: {
    p1: [
      {
        id: "d1",
        operatorEditable: ["latencyMs"],
        parameters: { base: 1 },
        eventDetailType: "Disruption.Latency",
      },
    ],
  },
} as unknown as EventSharedResources;

const baseInput: DisruptionFireInput = {
  tenantId: "t1",
  eventId: "e1",
  problemId: "p1",
  disruptionId: "d1",
  parameters: {},
  scope: "all",
  targetTeamIds: [],
  requestId: "req-12345678",
  firedBy: "sub-1",
  nowMs: 1_700_000_000_000,
  // biome-ignore lint/suspicious/noExplicitAny: optional randomCount filled per test.
} as any;
const input = (over: Partial<DisruptionFireInput>): DisruptionFireInput => ({
  ...baseInput,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  cfg.teams = [{ teamId: "team-1" }, { teamId: "team-2" }];
  cfg.claimCcf = false;
  cfg.claimError = undefined;
  cfg.duplicateRow = undefined;
  eventsSend.mockResolvedValue({ FailedEntryCount: 0 });
});

describe("fireDisruption", () => {
  it("should return unknown_problem when the problem has no catalog", async () => {
    expect(await fireDisruption(shared, input({ problemId: "pX" }))).toEqual({
      kind: "unknown_problem",
    });
  });

  it("should return unknown_disruption when the disruptionId is not declared", async () => {
    expect(await fireDisruption(shared, input({ disruptionId: "dX" }))).toEqual({
      kind: "unknown_disruption",
    });
  });

  it("should reject a parameter outside the operatorEditable allow-list", async () => {
    const out = await fireDisruption(shared, input({ parameters: { notAllowed: 1 } }));
    expect(out.kind).toBe("invalid_parameters");
  });

  it("should return no_targets when the event has no teams (Items undefined → [])", async () => {
    cfg.teams = undefined; // listTeamsByEvent's out.Items ?? [] default
    expect((await fireDisruption(shared, input({}))).kind).toBe("no_targets");
  });

  it("should return no_targets when scope=team matches no valid team", async () => {
    const out = await fireDisruption(shared, input({ scope: "team", targetTeamIds: ["ghost"] }));
    expect(out.kind).toBe("no_targets");
  });

  it("should return invalid_scope when too many teams are affected", async () => {
    cfg.teams = Array.from({ length: 201 }, (_, i) => ({ teamId: `team-${i}` }));
    expect((await fireDisruption(shared, input({ scope: "all" }))).kind).toBe("invalid_scope");
  });

  it("should fire scope=all, publish per team, write audit, and merge base parameters", async () => {
    const out = await fireDisruption(shared, input({ parameters: { latencyMs: 250 } }));
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.result.affectedTeamIds).toEqual(["team-1", "team-2"]);
    // publish detail carries merged parameters (base + operator).
    const published = JSON.parse(eventsSend.mock.calls[0][0].input.Entries[0].Detail);
    expect(published.parameters).toEqual({ base: 1, latencyMs: 250 });
    // audit row Put happened.
    expect(ddb.send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
  });

  it("should fire scope=team with dedup against valid teams", async () => {
    const out = await fireDisruption(
      shared,
      input({ scope: "team", targetTeamIds: ["team-1", "team-1", "ghost"] }),
    );
    expect(out.kind === "ok" && out.result.affectedTeamIds).toEqual(["team-1"]);
  });

  it("should fire scope=random-n clamped to randomCount", async () => {
    cfg.teams = [{ teamId: "a" }, { teamId: "b" }, { teamId: "c" }];
    const out = await fireDisruption(shared, input({ scope: "random-n", randomCount: 2 }));
    expect(out.kind === "ok" && out.result.affectedTeamIds.length).toBe(2);
  });

  it("should return duplicate from a fully-populated prior row (no publish)", async () => {
    cfg.claimCcf = true;
    cfg.duplicateRow = {
      auditId: "prev-audit",
      tenantId: "t1",
      eventId: "e1",
      problemId: "p1",
      disruptionId: "d1",
      firedBy: "sub",
      firedAt: "2026-06-01T00:00:00Z",
      scope: "all",
      targetTeamIds: ["team-1"],
      parameters: { base: 1 },
      requestId: "req-dup-001",
      expiresAt: 999,
    };
    const out = await fireDisruption(shared, input({ requestId: "req-dup-001" }));
    expect(out).toMatchObject({ kind: "duplicate", result: { auditId: "prev-audit" } });
    expect(eventsSend).not.toHaveBeenCalled(); // no publish on duplicate
  });

  it("should normalize a minimal prior row with input fallbacks", async () => {
    cfg.claimCcf = true;
    // only auditId present; targetTeamIds / parameters are the wrong type → [] / {} defaults;
    // all other fields fall back to the input.
    cfg.duplicateRow = { auditId: "min-audit", targetTeamIds: "nope", parameters: 5 };
    const out = await fireDisruption(shared, input({ requestId: "req-dup-002" }));
    expect(out).toMatchObject({
      kind: "duplicate",
      result: { auditId: "min-audit", affectedTeamIds: [] },
    });
  });

  it("should throw when the claim is contended but no prior row ever becomes visible", async () => {
    cfg.claimCcf = true;
    cfg.duplicateRow = undefined; // getDuplicate returns undefined on every retry → throw
    await expect(fireDisruption(shared, input({ requestId: "req-race" }))).rejects.toThrow(
      /no prior row visible/,
    );
  });

  it("should throw when EventBridge reports a failed publish entry", async () => {
    eventsSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "slow down" }],
    });
    await expect(fireDisruption(shared, input({}))).rejects.toThrow(/partial failure/);
  });

  it("should fire scope=random-n defaulting randomCount to 1 when omitted", async () => {
    const out = await fireDisruption(shared, input({ scope: "random-n" })); // no randomCount → 1
    expect(out.kind === "ok" && out.result.affectedTeamIds.length).toBe(1);
  });

  it("should rethrow a non-ConditionalCheck error from the idempotency claim", async () => {
    cfg.claimError = new Error("ddb claim down");
    await expect(fireDisruption(shared, input({ requestId: "req-err" }))).rejects.toThrow(
      "ddb claim down",
    );
  });

  it("should publish across multiple PutEvents batches when over 10 teams are affected", async () => {
    cfg.teams = Array.from({ length: 11 }, (_, i) => ({ teamId: `team-${i}` }));
    const out = await fireDisruption(shared, input({ scope: "all" }));
    expect(out.kind).toBe("ok");
    expect(eventsSend).toHaveBeenCalledTimes(2); // 11 entries / 10-per-batch → 2 calls
  });

  it("should throw on a failed entry that carries no ErrorCode/ErrorMessage", async () => {
    eventsSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "X" }, {}], // one with a code (no message → ""), one with neither
    });
    await expect(fireDisruption(shared, input({}))).rejects.toThrow(/partial failure/);
  });

  it("should treat a publish response with no FailedEntryCount as success", async () => {
    eventsSend.mockResolvedValueOnce({}); // FailedEntryCount undefined → ?? 0 → 0
    expect((await fireDisruption(shared, input({}))).kind).toBe("ok");
  });

  it("should not throw when FailedEntryCount is set but Entries is absent", async () => {
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 1 }); // resp.Entries ?? [] → no details
    expect((await fireDisruption(shared, input({}))).kind).toBe("ok");
  });
});

describe("fireDisruption with a declaration lacking optional fields", () => {
  it("should reject any parameter when operatorEditable is absent and merge with no base", async () => {
    const bareShared = {
      ...shared,
      problemsDisruptions: { p1: [{ id: "d1", eventDetailType: "D.Bare" }] },
      // biome-ignore lint/suspicious/noExplicitAny: reuse the same ddb/events fakes.
    } as any;
    // no operatorEditable → empty allow-list → any param rejected.
    expect((await fireDisruption(bareShared, input({ parameters: { x: 1 } }))).kind).toBe(
      "invalid_parameters",
    );
    // empty parameters → passes allow-list, declaration.parameters ?? {} default.
    expect((await fireDisruption(bareShared, input({ parameters: {} }))).kind).toBe("ok");
  });
});
