import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEventRoster } from "../../lib/problem-deploy/handlers/participant-handler/coordination-roster.js";
import {
  fakeParticipantShared,
  fakeParticipantSharedWithItems,
} from "./coordination.test-helpers.js";

/**
 * [Issue #3187] The one roster both hosts materialise a match from.
 *
 * The op path (`makeCoordinationScopeResolver`) and the scoring-driven tick
 * (`coordination-tick.ts`) each call `plugin.initialState(ctx)` when they find
 * no state, and whichever runs first decides what the plugin knows about the
 * teams for the whole match. The rule lives here so the two cannot drift; the
 * hosts' own suites pin that each of them actually calls it.
 */
describe("resolveEventRoster", () => {
  const target = { tenantId: "tn1", eventId: "e1", problemId: "p1" } as const;
  const row = (over: Record<string, unknown>) => ({ ...target, ...over });

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it("only passes reserved outputs from the same tenant, event and problem to the plugin", async () => {
    const roster = await resolveEventRoster(
      fakeParticipantSharedWithItems([
        row({
          teamId: "t1",
          stackOutputs: JSON.stringify({
            CoordinationPrivateMaterial: "fixture",
            CoordinationSetting: "on",
            PublicUrl: "https://example.test",
          }),
        }),
        row({
          teamId: "t2",
          problemId: "other",
          stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "other" }),
        }),
      ]),
      { ...target, knownTeamIds: ["t1"] },
    );
    expect(roster.deploymentInputs).toEqual({
      t1: { CoordinationPrivateMaterial: "fixture", CoordinationSetting: "on" },
    });
  });

  it("uses the newest deployment inputs regardless of repository iteration order", async () => {
    const old = row({
      teamId: "t1",
      jobId: "old",
      createdAt: "2026-09-01",
      stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "old" }),
    });
    const current = row({
      teamId: "t1",
      jobId: "new",
      createdAt: "2026-09-02",
      stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "current" }),
    });
    for (const rows of [
      [old, current],
      [current, old],
    ]) {
      const roster = await resolveEventRoster(fakeParticipantSharedWithItems(rows), {
        ...target,
        knownTeamIds: ["t1"],
      });
      expect(roster.deploymentInputs?.t1).toEqual({ CoordinationPrivateMaterial: "current" });
    }
    const pending = { ...current, stackOutputs: undefined };
    const roster = await resolveEventRoster(fakeParticipantSharedWithItems([pending, old]), {
      ...target,
      knownTeamIds: ["t1"],
    });
    expect(roster.deploymentInputs).toBeUndefined();
  });

  it("refreshes stale index values from a strongly consistent META read", async () => {
    const current = row({
      teamId: "t1",
      jobId: "job1",
      stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "current" }),
    });
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: current };
      return { Items: [{ ...current, stackOutputs: undefined }] };
    });
    const roster = await resolveEventRoster(fakeParticipantShared(send), {
      ...target,
      knownTeamIds: ["t1"],
      requireComplete: true,
    });
    expect(roster.deploymentInputs).toEqual({ t1: { CoordinationPrivateMaterial: "current" } });
    const reads = send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is GetCommand => cmd instanceof GetCommand);
    expect(reads.map((cmd) => cmd.input)).toEqual([
      {
        TableName: "Deployments",
        Key: { PK: "DEPLOYMENT#job1", SK: "META" },
        ConsistentRead: true,
      },
    ]);
  });

  it.each([
    undefined,
    { tenantId: "another-tenant" },
    { eventId: "another-event" },
    { problemId: "another-problem" },
    { teamId: "another-team" },
  ])("defers initialization if the authoritative deployment is missing or mismatched: %j", async (overrides) => {
    const indexed = row({
      teamId: "t1",
      jobId: "job1",
      stackOutputs: JSON.stringify({ CoordinationPrivateMaterial: "stale" }),
    });
    const send = vi.fn(async (cmd: unknown) =>
      cmd instanceof GetCommand
        ? { Item: overrides ? { ...indexed, ...overrides } : undefined }
        : { Items: [indexed] },
    );
    const shared = fakeParticipantShared(send);
    await expect(
      resolveEventRoster(shared, { ...target, knownTeamIds: ["t1"], requireComplete: true }),
    ).rejects.toThrow("missing or no longer belongs");
    const existing = await resolveEventRoster(shared, { ...target, knownTeamIds: ["t1"] });
    expect(existing.rosterIncomplete).toBe(true);
    expect(existing.deploymentInputs).toBeUndefined();
  });

  it("should union the rows' teams with the known ids, sorted, whatever their status", async () => {
    const roster = await resolveEventRoster(
      fakeParticipantSharedWithItems([
        row({ teamId: "t3", status: "COMPLETE" }),
        // Mid-deploy: still on the roster, or the roster would depend on
        // deploy timing and two hosts could materialise different matches (#3053).
        row({ teamId: "t1", status: "PENDING" }),
      ]),
      { ...target, knownTeamIds: ["t2"] },
    );
    expect(roster.teamIds).toEqual(["t1", "t2", "t3"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should name a team by its display name, then its operator slug, and leave an unnamed team out", async () => {
    const roster = await resolveEventRoster(
      fakeParticipantSharedWithItems([
        row({ teamId: "t1", displayTeamName: "かけら隊", teamName: "team-1" }),
        // A display name the team has not filled in yet does not beat the slug.
        row({ teamId: "t2", displayTeamName: "   ", teamName: "team-2" }),
        // Neither: left out rather than mapped to "", so the plugin's own
        // fallback to the id is what runs.
        row({ teamId: "t3" }),
        // A row with no team at all is not a team.
        row({ displayTeamName: "orphan" }),
      ]),
      { ...target, knownTeamIds: [] },
    );
    expect(roster).toEqual({
      teamIds: ["t1", "t2", "t3"],
      teamNames: { t1: "かけら隊", t2: "team-2" },
    });
  });

  it("should leave out teams that deployed a different problem in the same event", async () => {
    const roster = await resolveEventRoster(
      fakeParticipantSharedWithItems([
        row({ teamId: "t1" }),
        row({ teamId: "t9", problemId: "other", displayTeamName: "elsewhere" }),
      ]),
      { ...target, knownTeamIds: ["t1"] },
    );
    expect(roster).toEqual({ teamIds: ["t1"], teamNames: {} });
  });

  it("should fall back to the known ids, unnamed, and warn when the query fails", async () => {
    const roster = await resolveEventRoster(
      fakeParticipantShared(vi.fn(async () => Promise.reject(new Error("roster query failed")))),
      { ...target, knownTeamIds: ["t2", "t1"] },
    );
    // The caller can serve an existing match, but cannot persist this partial roster.
    expect(roster).toEqual({ teamIds: ["t1", "t2"], teamNames: {}, rosterIncomplete: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("roster query failed"),
      expect.objectContaining({ eventId: "e1", problemId: "p1", message: "roster query failed" }),
    );
  });

  it("should stringify a non-Error rejection in the warn", async () => {
    await resolveEventRoster(
      fakeParticipantShared(vi.fn(async () => Promise.reject("plain failure"))),
      { ...target, knownTeamIds: ["t1"] },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("roster query failed"),
      expect.objectContaining({ message: "plain failure" }),
    );
  });
});
