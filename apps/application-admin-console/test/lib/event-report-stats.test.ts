import { describe, expect, it } from "vitest";
import type { EventDetail } from "../../src/api/events-client";
import {
  buildDisruptionLog,
  buildProblemBreakdown,
  formatPercent,
  isReportReady,
} from "../../src/lib/event-report-stats";

/**
 * Event Report の pure 集計 helpers。 page render に依存しない math 部分を、 build-time の
 * `EventDetail` shape から直接 pin する。 scoreEventsByTeam / deploymentsByProblem の欠落 (=
 * Bulk Deploy 前 / 採点 0 件) と、 0 team の avg=0 防御、 disruption の occurredAt 昇順 sort を
 * 重点的に固定する。
 */
function makeDetail(overrides: Partial<EventDetail>): EventDetail {
  return {
    teams: [],
    problems: [],
    deploymentsByProblem: {},
    ...overrides,
  } as unknown as EventDetail;
}

describe("buildProblemBreakdown", () => {
  it("should return zeros when there are no teams, no score events, and no deployments", () => {
    const rows = buildProblemBreakdown(
      makeDetail({
        teams: [],
        problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
        // scoreEventsByTeam omitted (= ?? [] branch); deploymentsByProblem missing p1 (= ?? []).
        deploymentsByProblem: {},
      } as unknown as Partial<EventDetail>),
    );
    expect(rows).toEqual([
      {
        problemId: "p1",
        defaultRegion: "ap-northeast-1",
        solvedCount: 0,
        avgScore: 0,
        deploymentsCount: 0,
        successfulCount: 0,
      },
    ]);
  });

  it("should aggregate solved count, average score, and successful deployments", () => {
    const rows = buildProblemBreakdown(
      makeDetail({
        teams: [{ teamId: "t1" }, { teamId: "t2" }],
        problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
        scoreEventsByTeam: [
          {
            teamId: "t1",
            teamName: "Alpha",
            events: [
              {
                problemId: "p1",
                source: "flag",
                result: "ok",
                points: 100,
                occurredAt: "2026-05-21T10:00:00Z",
              },
            ],
          },
          {
            teamId: "t2",
            teamName: "Bravo",
            events: [
              {
                problemId: "p1",
                source: "flag-wrong",
                result: "wrong",
                points: -10,
                occurredAt: "2026-05-21T10:05:00Z",
              },
            ],
          },
        ],
        deploymentsByProblem: {
          p1: [{ status: "COMPLETE" }, { status: "FAILED" }],
        },
      } as unknown as Partial<EventDetail>),
    );
    expect(rows[0]).toEqual({
      problemId: "p1",
      defaultRegion: "ap-northeast-1",
      solvedCount: 1, // t1 solved via flag/ok; t2 only a wrong flag
      avgScore: 45, // (100 + -10) / 2 teams = 45.0
      deploymentsCount: 2,
      successfulCount: 1, // COMPLETE only
    });
  });
});

describe("buildDisruptionLog", () => {
  it("should return [] when there are no score events", () => {
    expect(buildDisruptionLog(makeDetail({}))).toEqual([]);
  });

  it("should collect flag-wrong / negative-point events sorted by occurredAt ascending", () => {
    const log = buildDisruptionLog(
      makeDetail({
        scoreEventsByTeam: [
          {
            teamId: "t1",
            teamName: "Alpha",
            events: [
              // positive non-flag-wrong event → excluded
              {
                problemId: "p1",
                source: "flag",
                result: "ok",
                points: 100,
                occurredAt: "2026-05-21T10:00:00Z",
              },
              // later flag-wrong → included (2nd after sort)
              {
                problemId: "p1",
                source: "flag-wrong",
                result: "wrong",
                points: -10,
                occurredAt: "2026-05-21T10:30:00Z",
              },
            ],
          },
          {
            teamId: "t2",
            teamName: "Bravo",
            events: [
              // earlier negative-point (non flag-wrong source) → included (1st after sort)
              {
                problemId: "p1",
                source: "hint",
                result: "ok",
                points: -5,
                occurredAt: "2026-05-21T10:10:00Z",
              },
            ],
          },
        ],
      } as unknown as Partial<EventDetail>),
    );
    expect(log.map((d) => `${d.teamId}@${d.occurredAt}`)).toEqual([
      "t2@2026-05-21T10:10:00Z",
      "t1@2026-05-21T10:30:00Z",
    ]);
    expect(log[0]).toMatchObject({ teamName: "Bravo", source: "hint", points: -5 });
  });
});

describe("isReportReady", () => {
  it("should be true only for ENDED / ARCHIVED events", () => {
    expect(isReportReady({ status: "ENDED" } as unknown as EventDetail)).toBe(true);
    expect(isReportReady({ status: "ARCHIVED" } as unknown as EventDetail)).toBe(true);
    expect(isReportReady({ status: "RUNNING" } as unknown as EventDetail)).toBe(false);
    expect(isReportReady(null)).toBe(false);
    expect(isReportReady(undefined)).toBe(false);
  });
});

describe("formatPercent", () => {
  it("should format a ratio as a percentage with one fraction digit by default", () => {
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(0.1234, 2)).toBe("12.34%");
  });

  it("should return an em-dash for a non-finite value", () => {
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
