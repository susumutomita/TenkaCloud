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
    // Neither host fails over this -- but a match that starts on the known
    // ids alone is what the live symptom looked like, so it is not silent.
    expect(roster).toEqual({ teamIds: ["t1", "t2"], teamNames: {} });
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
