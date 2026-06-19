import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DisruptionAuditRow } from "../../../src/api/disruptions-client";
import type { EventDetail } from "../../../src/api/events-client";
import { formatHm, TeamStatusPanel } from "../../../src/pages/event-detail/TeamStatusPanel";

/**
 * Issue #1916: TeamStatusPanel が per-team status を render する各 cell 分岐
 * (rank badge / deploy up・failed・deploying・none / latest ok・wrong・none / fired count・none /
 * 空テーブル) を pin する。 集計自体は team-status.test で検証済みなので、 ここは描画分岐に集中。
 */

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

// rank 1..5 になるよう score を段階化し、 deploy / latest / fired を team ごとに撃ち分ける。
const detail = {
  eventId: "EVT",
  teams: [
    { teamId: "A", internalSlug: "alpha", displayName: "Alpha" },
    { teamId: "B", internalSlug: "bravo", displayName: "Bravo" },
    { teamId: "C", internalSlug: "charlie", displayName: "Charlie" },
    { teamId: "D", internalSlug: "delta", displayName: "Delta" },
    { teamId: "E", internalSlug: "echo", displayName: "Echo" },
  ],
  deploymentsByProblem: {
    p1: [
      { jobId: "j1", teamId: "A", status: "COMPLETE" },
      { jobId: "j2", teamId: "B", status: "FAILED" },
      { jobId: "j3", teamId: "C", status: "IN_PROGRESS" },
      { jobId: "j5", teamId: "E", status: "COMPLETE" },
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
          points: 80,
          result: "wrong",
          occurredAt: "2026-06-18T10:01:00Z",
        },
      ],
    },
    {
      teamId: "C",
      teamName: "Charlie",
      events: [
        {
          jobId: "j3",
          problemId: "p1",
          source: "uptime",
          points: 60,
          result: "ok",
          occurredAt: "2026-06-18T10:02:00Z",
        },
      ],
    },
    {
      teamId: "D",
      teamName: "Delta",
      events: [
        {
          jobId: "j4",
          problemId: "p1",
          source: "flag",
          points: 40,
          result: "ok",
          occurredAt: "2026-06-18T10:03:00Z",
        },
      ],
    },
  ],
} as unknown as EventDetail;

const audit = [
  { firedAt: "2026-06-18T10:05:00Z", targetTeamIds: ["A", "C"] },
  { firedAt: "2026-06-18T10:06:00Z", targetTeamIds: ["A"] },
] as unknown as DisruptionAuditRow[];

describe("TeamStatusPanel (#1916)", () => {
  it("should render the header and one row per team", () => {
    render(<TeamStatusPanel detail={detail} audit={audit} t={t} />);
    expect(screen.getByText("disruptions.team_status_header")).toBeInTheDocument();
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("should render every deploy state (up / failed / deploying / none)", () => {
    render(<TeamStatusPanel detail={detail} audit={audit} t={t} />);
    // A & E COMPLETE → up (2 cells)
    expect(
      screen.getAllByText('disruptions.team_status_deploy_up:{"complete":1,"total":1}'),
    ).toHaveLength(2);
    expect(
      screen.getByText('disruptions.team_status_deploy_failed:{"count":1}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('disruptions.team_status_deploy_progress:{"count":1}'),
    ).toBeInTheDocument();
    // D has no deployment rows → none
    expect(screen.getByText("disruptions.team_status_deploy_none")).toBeInTheDocument();
  });

  it("should render latest scoring (source for ok/wrong, placeholder when none)", () => {
    render(<TeamStatusPanel detail={detail} audit={audit} t={t} />);
    // sources are shown via StatusIndicator (flag for A/D ok, uptime for B wrong / C ok)
    expect(screen.getAllByText("uptime").length).toBeGreaterThan(0);
    expect(screen.getAllByText("flag").length).toBeGreaterThan(0);
    // E has no score events → "no scoring yet"
    expect(screen.getByText("disruptions.team_status_latest_none")).toBeInTheDocument();
  });

  it("should render fired-disruption counts and a placeholder for teams not hit", () => {
    render(<TeamStatusPanel detail={detail} audit={audit} t={t} />);
    // A hit twice, C once → count cells; B/D/E none.
    expect(screen.getByText(/team_status_fired_count:.*"count":2/)).toBeInTheDocument();
    expect(screen.getByText(/team_status_fired_count:.*"count":1/)).toBeInTheDocument();
    expect(screen.getAllByText("disruptions.team_status_fired_none")).toHaveLength(3);
  });

  it("should show the empty state when the event has no teams", () => {
    const noTeams = { ...detail, teams: [], scoreEventsByTeam: [] } as unknown as EventDetail;
    render(<TeamStatusPanel detail={noTeams} audit={[]} t={t} />);
    expect(screen.getByText("disruptions.team_status_empty")).toBeInTheDocument();
  });
});

describe("formatHm", () => {
  it("should format an ISO timestamp as zero-padded HH:mm", () => {
    expect(formatHm("2026-06-18T10:05:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("should return an em dash for null", () => {
    expect(formatHm(null)).toBe("—");
  });

  it("should return an em dash for an unparseable value", () => {
    expect(formatHm("not-a-date")).toBe("—");
  });
});
