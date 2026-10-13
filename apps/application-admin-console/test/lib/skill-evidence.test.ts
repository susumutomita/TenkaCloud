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

it("orders retained observations and preserves a success after a failed attempt", () => {
  const detail = evidenceFixture();
  const team = detail.scoreEventsByTeam?.[0];
  const accepted = team?.events[0];
  if (!team || !accepted) throw new Error("fixture missing");
  team.events = [accepted, { ...accepted, result: "wrong", occurredAt: "2026-10-01T00:00:30Z" }];
  detail.teams = detail.teams.map((row) => ({ ...row, displayName: `Team ${row.teamId}` }));
  const evidence = buildSkillEvidence(detail)[0];
  expect(evidence?.status).toBe("demonstrated");
  expect(evidence?.teamName).toBe("Team alpha");
  expect(evidence?.observations.map((row) => row.result)).toEqual(["wrong", "ok"]);
});

it("counts a cloud uptime row as a successful probe only when it awarded points", () => {
  const detail = evidenceFixture();
  const team = detail.scoreEventsByTeam?.[0];
  const [flag, probe] = team?.events ?? [];
  if (!team || !flag || !probe) throw new Error("fixture missing");
  // Cloud uptime-flat / uptime-multi store a failed probe as `ok` with the configured penalty.
  team.events = [
    { ...flag, points: 0 },
    { ...probe, points: -10 },
    { ...probe, points: 0, occurredAt: "2026-10-01T00:02:00Z" },
  ];
  const [answered, failed] = buildSkillEvidence(detail);
  expect(answered?.status).toBe("demonstrated");
  expect(failed?.status).toBe("not_observed");
  expect(failed?.observations.map((row) => row.result)).toEqual(["wrong", "wrong"]);
  team.events = [...team.events, { ...probe, points: 5, occurredAt: "2026-10-01T00:03:00Z" }];
  const recovered = buildSkillEvidence(detail)[1];
  expect(recovered?.status).toBe("demonstrated");
  expect(recovered?.observations.map((row) => row.result)).toEqual(["wrong", "wrong", "ok"]);
});

it("accepts only canonical UTC observation instants", () => {
  const detail = evidenceFixture();
  const team = detail.scoreEventsByTeam?.[0];
  const accepted = team?.events[0];
  if (!team || !accepted) throw new Error("fixture missing");
  // Date.parse accepts both: "0" as 2000-01-01 and February 30 rolled into March.
  for (const occurredAt of [
    "0",
    "2026-02-30T00:00:00Z",
    "2026-10-01 00:01:00Z",
    "2026-10-01T00:01:00+09:00",
  ]) {
    team.events = [{ ...accepted, occurredAt }];
    expect(buildSkillEvidence(detail)[0]?.reason).toBe("observation_missing");
  }
  team.events = [{ ...accepted, occurredAt: "2026-10-01T00:01:00.000Z" }];
  expect(buildSkillEvidence(detail)[0]?.status).toBe("demonstrated");
});

it("requires complete team history and a retained job even when an accepted result exists", () => {
  const detail = evidenceFixture();
  const team = detail.scoreEventsByTeam?.[0];
  if (!team) throw new Error("fixture missing");
  team.historyAvailable = false;
  expect(buildSkillEvidence(detail)[0]?.reason).toBe("history_missing");
  delete team.historyAvailable;
  detail.deploymentsByProblem = {};
  expect(buildSkillEvidence(detail)[0]?.reason).toBe("observation_missing");
});

it("fails closed for historical snapshots missing revision or scoring classification", () => {
  const detail = evidenceFixture();
  const snapshot = detail.problems[0]?.skillCatalog;
  if (!snapshot) throw new Error("fixture missing");
  Reflect.deleteProperty(snapshot, "revision");
  expect(buildSkillEvidence(detail)[0]?.reason).toBe("revision_missing");
  Reflect.deleteProperty(snapshot, "scoringKind");
  expect(buildSkillEvidence(detail)[0]?.reason).toBe("scoring_unsupported");
});
