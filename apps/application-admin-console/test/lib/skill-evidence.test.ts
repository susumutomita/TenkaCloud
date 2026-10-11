import { describe, expect, it } from "vitest";
import { buildScoreboard } from "../../src/lib/event-report-stats";
import { buildSkillEvidence } from "../../src/lib/skill-evidence";
import { evidenceFixture } from "../fixtures/skill-evidence";

describe("source-backed team evidence", () => {
  it("uses the current bilingual Challenge and one-endpoint Battle contract, after teardown", () => {
    const detail = evidenceFixture();
    expect(buildSkillEvidence(detail).map((row) => row.status)).toEqual([
      "demonstrated",
      "demonstrated",
      "not_observed",
      "not_observed",
    ]);
    expect(buildSkillEvidence(detail)[1]?.englishLabel).toBe(
      "Successful probe of a registered service endpoint",
    );
    expect(buildSkillEvidence(detail)[0]?.observations[0]?.jobId).toBe("hello-world-alpha");
  });
  it("never turns 100 total points or unrelated sources into a demonstrated skill", () => {
    const detail = evidenceFixture();
    detail.scoreEventsByTeam = detail.scoreEventsByTeam?.map((team) => ({
      ...team,
      events: team.events.map((event) => ({ ...event, source: "gate-bonus" as const })),
    }));
    expect(buildSkillEvidence(detail).every((row) => row.status === "not_observed")).toBe(true);
  });
  it("wrong results and empty history are not observed, unavailable history is insufficient", () => {
    const detail = evidenceFixture();
    detail.scoreEventsByTeam = detail.scoreEventsByTeam?.map((team) => ({
      ...team,
      events: team.events.map((event) => ({ ...event, result: "wrong" as const })),
    }));
    expect(buildSkillEvidence(detail)[0]?.status).toBe("not_observed");
    detail.scoreHistoryAvailable = false;
    expect(buildSkillEvidence(detail).every((row) => row.reason === "history_missing")).toBe(true);
    delete detail.scoreHistoryAvailable;
    delete detail.scoreEventsByTeam;
    expect(buildSkillEvidence(detail)[0]?.status).toBe("insufficient_evidence");
  });
  it("deduplicates retries, isolates teams and does not mutate scores or the input", () => {
    const detail = evidenceFixture();
    const team = detail.scoreEventsByTeam?.[0];
    if (!team) throw new Error("fixture missing");
    team.events = [...team.events, ...team.events];
    const before = JSON.stringify(detail);
    const scores = buildScoreboard(detail.teams, detail.scoreEventsByTeam);
    expect(buildSkillEvidence(detail)[0]?.observations).toHaveLength(1);
    expect(buildSkillEvidence(detail)[2]?.status).toBe("not_observed");
    expect(JSON.stringify(detail)).toBe(before);
    expect(buildScoreboard(detail.teams, detail.scoreEventsByTeam)).toEqual(scores);
  });
  it("marks old metadata, unknown revision and unsupported scoring explicitly", () => {
    const detail = evidenceFixture();
    const first = detail.problems[0];
    if (!first?.skillCatalog) throw new Error("fixture missing");
    first.skillCatalog = { ...first.skillCatalog, revision: "unknown" };
    expect(buildSkillEvidence(detail)[0]?.reason).toBe("revision_missing");
    first.skillCatalog = { ...first.skillCatalog, scoringKind: "multi-flag" };
    expect(buildSkillEvidence(detail)[0]?.status).toBe("not_assessable");
    delete first.skillCatalog;
    expect(buildSkillEvidence(detail)[0]?.reason).toBe("metadata_missing");
  });
  it("does not fabricate traceability for missing timestamps or mismatched deployment IDs", () => {
    const detail = evidenceFixture();
    const team = detail.scoreEventsByTeam?.[0];
    if (!team) throw new Error("fixture missing");
    team.events = team.events.map((event) => ({ ...event, occurredAt: "invalid" }));
    expect(buildSkillEvidence(detail)[0]?.reason).toBe("observation_missing");
    team.events = team.events.map((event) => ({
      ...event,
      occurredAt: "2026-10-01T00:01:00Z",
      jobId: "hello-world-beta",
    }));
    expect(buildSkillEvidence(detail)[0]?.reason).toBe("observation_missing");
    expect(buildSkillEvidence(detail)[0]?.observations).toEqual([]);
  });
});
