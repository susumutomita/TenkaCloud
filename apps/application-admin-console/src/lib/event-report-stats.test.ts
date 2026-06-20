import { describe, expect, it } from "vitest";
import type { EventDetail, TeamScoreEvents } from "../api/events-client";
import {
  buildDisruptionLog,
  buildProblemBreakdown,
  buildScoreboard,
  formatPercent,
  isReportReady,
  summarizeEvent,
} from "./event-report-stats";

const TEAM_ALPHA = { teamId: "team-A", internalSlug: "alpha", displayName: "Team Alpha" };
const TEAM_BRAVO = { teamId: "team-B", internalSlug: "bravo", displayName: "Team Bravo" };
const TEAM_CHARLIE = { teamId: "team-C", internalSlug: "charlie" };

function makeDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  const base: EventDetail = {
    eventId: "01HXTEST",
    name: "Test Event",
    status: "ENDED",
    teamCount: 3,
    problemCount: 2,
    createdAt: "2026-05-20T00:00:00Z",
    updatedAt: "2026-05-21T00:00:00Z",
    expiresAt: 0,
    teams: [TEAM_ALPHA, TEAM_BRAVO, TEAM_CHARLIE],
    problems: [
      { problemId: "battle/uptime-foo", defaultRegion: "ap-northeast-1" },
      { problemId: "challenge/flag-bar", defaultRegion: "us-east-1" },
    ],
    deploymentsByProblem: {
      "battle/uptime-foo": [
        { jobId: "j1", teamId: "team-A", status: "COMPLETE" },
        { jobId: "j2", teamId: "team-B", status: "COMPLETE" },
        { jobId: "j3", teamId: "team-C", status: "FAILED" },
      ],
      "challenge/flag-bar": [
        { jobId: "j4", teamId: "team-A", status: "AUTO_DELETED" },
        { jobId: "j5", teamId: "team-B", status: "DELETED" },
        { jobId: "j6", teamId: "team-C", status: "EXPIRED" },
      ],
    },
  };
  return { ...base, ...overrides };
}

function makeScoreEvents(): readonly TeamScoreEvents[] {
  return [
    {
      teamId: "team-A",
      teamName: "Team Alpha",
      events: [
        {
          jobId: "j1",
          problemId: "battle/uptime-foo",
          source: "uptime",
          points: 50,
          result: "ok",
          occurredAt: "2026-05-21T10:00:00Z",
        },
        {
          jobId: "j4",
          problemId: "challenge/flag-bar",
          source: "flag",
          points: 100,
          result: "ok",
          occurredAt: "2026-05-21T10:05:00Z",
        },
      ],
    },
    {
      teamId: "team-B",
      teamName: "Team Bravo",
      events: [
        {
          jobId: "j2",
          problemId: "battle/uptime-foo",
          source: "uptime",
          points: 30,
          result: "ok",
          occurredAt: "2026-05-21T10:00:00Z",
        },
        {
          jobId: "j5",
          problemId: "challenge/flag-bar",
          source: "flag-wrong",
          points: -10,
          result: "wrong",
          occurredAt: "2026-05-21T10:02:00Z",
        },
      ],
    },
    {
      teamId: "team-C",
      teamName: "Team Charlie",
      events: [],
    },
  ];
}

describe("event-report-stats", () => {
  describe("summarizeEvent", () => {
    it("should count teams / problems / deployments and compute success rate", () => {
      const summary = summarizeEvent(makeDetail());
      expect(summary.teamCount).toBe(3);
      expect(summary.problemCount).toBe(2);
      expect(summary.totalDeployments).toBe(6);
      // COMPLETE × 2 + AUTO_DELETED × 1 + DELETED × 1 = 4 (cleaned-up deploys still count as success)
      expect(summary.successfulDeployments).toBe(4);
      // FAILED × 1 + EXPIRED × 1 = 2
      expect(summary.failedDeployments).toBe(2);
      expect(summary.successRate).toBeCloseTo(0.667);
    });

    it("should return successRate = 0 when there are zero deployments", () => {
      const detail = makeDetail({ deploymentsByProblem: {} });
      const summary = summarizeEvent(detail);
      expect(summary.totalDeployments).toBe(0);
      expect(summary.successRate).toBe(0);
    });
  });

  describe("buildScoreboard", () => {
    it("should rank teams by total score descending with tie-break on earlier last-update", () => {
      const detail = makeDetail();
      const rows = buildScoreboard(detail.teams, makeScoreEvents());
      expect(rows).toHaveLength(3);
      expect(rows[0]?.teamId).toBe("team-A");
      expect(rows[0]?.rank).toBe(1);
      expect(rows[0]?.totalScore).toBe(150);
      // Team A solved 1 flag (challenge/flag-bar); uptime does not count as "solved"
      expect(rows[0]?.problemsSolved).toBe(1);
      expect(rows[1]?.teamId).toBe("team-B");
      expect(rows[1]?.totalScore).toBe(20);
      expect(rows[1]?.problemsSolved).toBe(0);
      // Team C has no events → score 0 / solved 0
      expect(rows[2]?.totalScore).toBe(0);
    });

    it("should fall back to internalSlug when displayName is missing", () => {
      const detail = makeDetail();
      const rows = buildScoreboard(detail.teams, makeScoreEvents());
      const charlie = rows.find((r) => r.teamId === "team-C");
      expect(charlie?.teamName).toBe("charlie");
    });

    it("should treat undefined scoreEvents as zero score for every team", () => {
      const detail = makeDetail();
      const rows = buildScoreboard(detail.teams, undefined);
      expect(rows.every((r) => r.totalScore === 0)).toBe(true);
      expect(rows.every((r) => r.problemsSolved === 0)).toBe(true);
    });
  });

  describe("buildProblemBreakdown", () => {
    it("should compute per-problem solved count / avg score / deploy success", () => {
      const detail = makeDetail({ scoreEventsByTeam: makeScoreEvents() });
      const rows = buildProblemBreakdown(detail);
      expect(rows).toHaveLength(2);
      const battle = rows.find((r) => r.problemId === "battle/uptime-foo");
      const challenge = rows.find((r) => r.problemId === "challenge/flag-bar");
      // battle: 0 solved (uptime is not a flag), avg = (50 + 30) / 3 teams = 26.7
      expect(battle?.solvedCount).toBe(0);
      expect(battle?.avgScore).toBeCloseTo(26.7);
      expect(battle?.deploymentsCount).toBe(3);
      expect(battle?.successfulCount).toBe(2);
      // challenge: 1 solved (Team A); avg = (100 + -10) / 3 = 30
      expect(challenge?.solvedCount).toBe(1);
      expect(challenge?.avgScore).toBeCloseTo(30);
      // AUTO_DELETED + DELETED both count as success (EXPIRED does not)
      expect(challenge?.successfulCount).toBe(2);
    });
  });

  describe("buildDisruptionLog", () => {
    it("should pick up flag-wrong / negative-point events in chronological order", () => {
      const detail = makeDetail({ scoreEventsByTeam: makeScoreEvents() });
      const entries = buildDisruptionLog(detail);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.teamId).toBe("team-B");
      expect(entries[0]?.source).toBe("flag-wrong");
      expect(entries[0]?.points).toBe(-10);
    });

    it("should return an empty array when there are no disruption events", () => {
      const detail = makeDetail({ scoreEventsByTeam: [] });
      expect(buildDisruptionLog(detail)).toEqual([]);
    });
  });

  describe("isReportReady", () => {
    it("should return true for ENDED / ARCHIVED status only", () => {
      expect(isReportReady(makeDetail({ status: "ENDED" }))).toBe(true);
      expect(isReportReady(makeDetail({ status: "ARCHIVED" }))).toBe(true);
      expect(isReportReady(makeDetail({ status: "READY" }))).toBe(false);
      expect(isReportReady(makeDetail({ status: "DRAFT" }))).toBe(false);
      expect(isReportReady(null)).toBe(false);
      expect(isReportReady(undefined)).toBe(false);
    });
  });

  describe("formatPercent", () => {
    it("should format 0..1 as percentage with default 1 decimal", () => {
      expect(formatPercent(0)).toBe("0.0%");
      expect(formatPercent(0.5)).toBe("50.0%");
      expect(formatPercent(0.8333)).toBe("83.3%");
    });

    it("should return an em-dash for non-finite input", () => {
      expect(formatPercent(Number.NaN)).toBe("—");
    });
  });
});
