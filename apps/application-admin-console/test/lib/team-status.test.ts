import { describe, expect, it } from "vitest";
import type { DisruptionAuditRow } from "../../src/api/disruptions-client";
import type { EventDetail } from "../../src/api/events-client";
import { assembleTeamStatus } from "../../src/lib/team-status";

/**
 * Issue #1916: assembleTeamStatus が EventDetail + disruption audit から per-team status を
 * 組み立てる集計を pin する。 deploy 状況 (up / deploying / failed / none)、 直近採点、
 * 撃ち込み履歴の per-team 集計、 ranking 再利用を直接検証する。
 */

const TEAM_A = { teamId: "A", internalSlug: "alpha", displayName: "Alpha" };
const TEAM_B = { teamId: "B", internalSlug: "bravo", displayName: "Bravo" };
const TEAM_C = { teamId: "C", internalSlug: "charlie" };
const TEAM_D = { teamId: "D", internalSlug: "delta" };

function detail(): EventDetail {
  return {
    eventId: "EVT",
    teams: [TEAM_A, TEAM_B, TEAM_C, TEAM_D],
    deploymentsByProblem: {
      p1: [
        { jobId: "j1", teamId: "A", status: "COMPLETE" },
        { jobId: "j2", teamId: "B", status: "IN_PROGRESS" },
        { jobId: "j3", teamId: "C", status: "FAILED" },
      ],
      p2: [
        { jobId: "j4", teamId: "A", status: "COMPLETE" },
        { jobId: "j5", teamId: "B", status: "PENDING" },
      ],
    },
    scoreEventsByTeam: [
      {
        teamId: "A",
        teamName: "Alpha",
        events: [
          {
            jobId: "j1",
            problemId: "p1",
            source: "flag",
            points: 100,
            result: "ok",
            occurredAt: "2026-06-18T10:00:00Z",
          },
          {
            jobId: "j1",
            problemId: "p1",
            source: "uptime",
            points: 0,
            result: "ok",
            occurredAt: "2026-06-18T10:05:00Z",
          },
        ],
      },
      {
        teamId: "B",
        teamName: "Bravo",
        events: [
          {
            jobId: "j2",
            problemId: "p1",
            source: "uptime",
            points: 30,
            result: "wrong",
            occurredAt: "2026-06-18T10:02:00Z",
          },
        ],
      },
    ],
  } as unknown as EventDetail;
}

function audit(): readonly DisruptionAuditRow[] {
  return [
    { firedAt: "2026-06-18T10:01:00Z", targetTeamIds: ["A", "B"] },
    { firedAt: "2026-06-18T10:09:00Z", targetTeamIds: ["A"] },
    // 後勝ちしない (= より古い) 行。 lastFiredAt は 10:09 のまま据え置かれる。
    { firedAt: "2026-06-18T10:00:00Z", targetTeamIds: ["A"] },
  ] as unknown as DisruptionAuditRow[];
}

describe("assembleTeamStatus (#1916)", () => {
  it("should return one row per team, ranked by cumulative score", () => {
    const rows = assembleTeamStatus(detail(), audit());
    expect(rows.map((r) => r.teamId)).toEqual(["A", "B", "C", "D"]);
    expect(rows[0]).toMatchObject({ teamId: "A", rank: 1, totalScore: 100, problemsSolved: 1 });
    expect(rows[1]).toMatchObject({ teamId: "B", rank: 2, totalScore: 30 });
    // C と D は 0 点同着 → 同順位。
    expect(rows[2].rank).toBe(3);
    expect(rows[3].rank).toBe(3);
  });

  it("should aggregate per-team deploy status across problems", () => {
    const rows = assembleTeamStatus(detail(), audit());
    const byId = Object.fromEntries(rows.map((r) => [r.teamId, r]));
    expect(byId.A.deploy).toEqual({ total: 2, complete: 2, failed: 0, inProgress: 0 });
    expect(byId.B.deploy).toEqual({ total: 2, complete: 0, failed: 0, inProgress: 2 });
    expect(byId.C.deploy).toEqual({ total: 1, complete: 0, failed: 1, inProgress: 0 });
    // D は deployment 行を持たない。
    expect(byId.D.deploy).toEqual({ total: 0, complete: 0, failed: 0, inProgress: 0 });
  });

  it("should expose the latest scoring event per team (null when none)", () => {
    const rows = assembleTeamStatus(detail(), audit());
    const byId = Object.fromEntries(rows.map((r) => [r.teamId, r]));
    expect(byId.A.latest).toEqual({
      result: "ok",
      source: "uptime",
      occurredAt: "2026-06-18T10:05:00Z",
    });
    expect(byId.B.latest).toEqual({
      result: "wrong",
      source: "uptime",
      occurredAt: "2026-06-18T10:02:00Z",
    });
    expect(byId.C.latest).toBeNull();
    expect(byId.D.latest).toBeNull();
  });

  it("should count fired disruptions per team with the most recent fire time", () => {
    const rows = assembleTeamStatus(detail(), audit());
    const byId = Object.fromEntries(rows.map((r) => [r.teamId, r]));
    // A は 3 回撃たれたが、 最後の行が最古なので lastFiredAt は 10:09 のまま (後勝ちしない)。
    expect(byId.A).toMatchObject({ disruptionsFired: 3, lastFiredAt: "2026-06-18T10:09:00Z" });
    expect(byId.B).toMatchObject({ disruptionsFired: 1, lastFiredAt: "2026-06-18T10:01:00Z" });
    expect(byId.C).toMatchObject({ disruptionsFired: 0, lastFiredAt: null });
  });

  it("should bucket EXPIRED as failed and leave cleaned-up (DELETED) deployments uncounted", () => {
    const d = {
      eventId: "EVT",
      teams: [{ teamId: "X", internalSlug: "x" }],
      deploymentsByProblem: {
        p1: [
          { jobId: "j1", teamId: "X", status: "EXPIRED" },
          { jobId: "j2", teamId: "X", status: "DELETED" },
        ],
      },
      scoreEventsByTeam: [],
    } as unknown as EventDetail;
    const [row] = assembleTeamStatus(d, []);
    // EXPIRED → failed; DELETED は bucket 対象外 (total だけ数える)。
    expect(row.deploy).toEqual({ total: 2, complete: 0, failed: 1, inProgress: 0 });
  });

  it("should tolerate a missing score-event timeline (all teams at zero)", () => {
    const rows = assembleTeamStatus(
      { ...detail(), scoreEventsByTeam: undefined } as unknown as EventDetail,
      [],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.totalScore === 0 && r.latest === null)).toBe(true);
    expect(rows.every((r) => r.disruptionsFired === 0)).toBe(true);
  });
});
