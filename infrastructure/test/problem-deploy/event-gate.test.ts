import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type EventGate,
  evaluateGate,
  getEventGate,
} from "../../lib/problem-deploy/handlers/participant-handler/event-gate";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

const NOW = Date.parse("2026-06-13T12:00:00.000Z");

function gate(over: Partial<EventGate> = {}): EventGate {
  return {
    scoringLocked: false,
    startsAt: "2026-06-13T10:00:00.000Z",
    endsAt: "2026-06-13T18:00:00.000Z",
    status: "ACTIVE",
    scoreboardFreezeMinutes: undefined,
    ...over,
  };
}

describe("evaluateGate", () => {
  // --- existing behavior (regression guard) ---
  it("should block (scoring_not_started) when the gate is absent (event row missing)", () => {
    expect(evaluateGate(undefined, NOW)).toEqual({ kind: "scoring_not_started" });
  });

  it("should block (scoring_ended) when status is ENDED or ARCHIVED", () => {
    expect(evaluateGate(gate({ status: "ENDED" }), NOW)).toMatchObject({ kind: "scoring_ended" });
    expect(evaluateGate(gate({ status: "ARCHIVED" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });

  it("should block (scoring_not_started) when startsAt is unset", () => {
    expect(evaluateGate(gate({ startsAt: undefined }), NOW)).toEqual({
      kind: "scoring_not_started",
    });
  });

  it("should block (scoring_not_started) before startsAt", () => {
    expect(evaluateGate(gate({ startsAt: "2026-06-13T13:00:00.000Z" }), NOW)).toMatchObject({
      kind: "scoring_not_started",
    });
  });

  it("should block (scoring_ended) after endsAt", () => {
    expect(evaluateGate(gate({ endsAt: "2026-06-13T11:00:00.000Z" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });

  it("should block (scoring_locked) when scoringLocked is true within the window", () => {
    expect(evaluateGate(gate({ scoringLocked: true }), NOW)).toEqual({ kind: "scoring_locked" });
  });

  it("should allow (undefined) within the competition window and unlocked", () => {
    expect(evaluateGate(gate(), NOW)).toBeUndefined();
  });

  // --- fail-closed on corrupt timestamps (the bug: module documents fail-closed
  //     but Date.parse NaN previously fell THROUGH to allow scoring) ---
  it("should fail closed (scoring_not_started) when startsAt is an unparseable string", () => {
    // z.string() (no .datetime()) lets a non-ISO startsAt be stored. The old code did
    // `Number.isFinite(NaN) && ...` -> false -> skipped the block -> scoring ALLOWED
    // before any verifiable start. Fail-closed: an unverifiable start blocks scoring.
    expect(evaluateGate(gate({ startsAt: "not-a-date" }), NOW)).toMatchObject({
      kind: "scoring_not_started",
    });
  });

  it("should fail closed (scoring_ended) when endsAt is an unparseable string", () => {
    // A corrupt endsAt means we cannot verify we are before the end. Fail-closed:
    // treat it as ended rather than accept scores past an unverifiable window.
    expect(evaluateGate(gate({ endsAt: "garbage" }), NOW)).toMatchObject({
      kind: "scoring_ended",
    });
  });
});

/**
 * #2436: getEventGate は repository seam (events.getEvent) 経由になり、 team の tenantId を
 * 渡して tenant scope を照合する。 default backend では従来と byte 互換の GetCommand を
 * `shared.ddb` 経由で発火する。 tenant 一致 → gate、 tenant 不一致 / 不在 / DDB error /
 * tenantId 導出不能 → fail-closed (undefined)。
 */
describe("getEventGate", () => {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches a single GetCommand.
  function buildShared(sendImpl: (cmd: any) => Promise<unknown>): {
    shared: ParticipantSharedResources;
    send: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn(sendImpl);
    const shared = {
      ddb: { send },
      eventsTableName: "TestEvents",
    } as unknown as ParticipantSharedResources;
    return { shared, send };
  }

  const eventItem = {
    tenantId: "t1",
    status: "READY",
    scoringLocked: true,
    startsAt: "2026-06-13T10:00:00.000Z",
    endsAt: "2026-06-13T18:00:00.000Z",
    scoreboardFreezeMinutes: 15,
  };

  it("should return the mapped gate when the event belongs to the tenant", async () => {
    const { shared, send } = buildShared(async (cmd) => {
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input.TableName).toBe("TestEvents");
      return { Item: eventItem };
    });
    const g = await getEventGate(shared, "t1", "e1");
    expect(g).toEqual({
      scoringLocked: true,
      startsAt: "2026-06-13T10:00:00.000Z",
      endsAt: "2026-06-13T18:00:00.000Z",
      status: "READY",
      scoreboardFreezeMinutes: 15,
      progressionGate: undefined,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should fail closed (undefined) on a tenant mismatch (getEvent scopes by tenant)", async () => {
    const { shared } = buildShared(async () => ({ Item: { ...eventItem, tenantId: "other" } }));
    expect(await getEventGate(shared, "t1", "e1")).toBeUndefined();
  });

  it("should fail closed (undefined) when the event row is absent", async () => {
    const { shared } = buildShared(async () => ({ Item: undefined }));
    expect(await getEventGate(shared, "t1", "e1")).toBeUndefined();
  });

  it("should fail closed (undefined) without a DDB read when tenantId is not derivable", async () => {
    const { shared, send } = buildShared(async () => ({ Item: eventItem }));
    expect(await getEventGate(shared, undefined, "e1")).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("should fail closed (undefined) on a DDB error", async () => {
    const { shared } = buildShared(async () => {
      throw new Error("ddb boom");
    });
    expect(await getEventGate(shared, "t1", "e1")).toBeUndefined();
  });
});
