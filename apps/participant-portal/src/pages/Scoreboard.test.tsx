import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse } from "../api/portal-client";
import type { AppConfig } from "../config";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";
import { ScoreboardPage } from "./Scoreboard";

/**
 * Issue #1793: 単体デプロイ (= Event 外) では leaderboard が `no_event` になり、参加者には
 * 「他チームのスコアが見えない = 機能が無い」ように見えていた。Scoreboard が no_event 状態を
 * Alert で明示し、コピーが「イベント経由で参加すれば他チームが見える」という対処を案内する
 * ことを pin する。
 */

vi.mock("../i18n", () => ({
  useT: () => (key: string) => key,
  useLang: () => "ja",
}));
vi.mock("../config-context", () => ({
  useIsMock: () => false,
}));

const teamView: {
  leaderboard: LeaderboardResponse | null;
  leaderboardError: string | null;
  leaderboardNoEvent: boolean;
} = { leaderboard: null, leaderboardError: null, leaderboardNoEvent: false };

vi.mock("../auth/TeamViewProvider", () => ({
  useTeamView: () => teamView,
}));

const config = { eventTitle: "Test Event" } as AppConfig;

describe("ScoreboardPage no_event state (#1793)", () => {
  beforeEach(() => {
    teamView.leaderboard = null;
    teamView.leaderboardError = null;
    teamView.leaderboardNoEvent = false;
  });

  it("should explain the no_event state with an alert instead of an endless spinner", () => {
    teamView.leaderboardNoEvent = true;
    render(<ScoreboardPage config={config} />);

    expect(screen.getByText("scoreboard.no_event_header")).toBeDefined();
    expect(screen.getByText("scoreboard.no_event_body")).toBeDefined();
    // no_event が確定したら loading spinner は出さない。
    expect(screen.queryByText("app.loading")).toBeNull();
  });

  it("should render the ranking table and Result Card when the leaderboard is event-scoped", () => {
    teamView.leaderboard = {
      eventId: "EV1",
      entries: [
        {
          rank: 1,
          teamId: "team-rival",
          teamName: "rival",
          score: 120,
          completedProblems: 2,
          totalProblems: 3,
          isMyTeam: false,
        },
        {
          rank: 2,
          teamId: "team-we",
          teamName: "we",
          score: 80,
          completedProblems: 1,
          totalProblems: 3,
          isMyTeam: true,
        },
      ],
    };
    render(<ScoreboardPage config={config} />);

    expect(screen.getByText("rival")).toBeDefined();
    expect(screen.getByText("we")).toBeDefined();
    expect(screen.getByText("result_card.title")).toBeDefined();
    expect(screen.queryByText("scoreboard.no_event_header")).toBeNull();
  });

  it("should not expose a Result Card while the scoreboard is frozen", () => {
    teamView.leaderboard = {
      eventId: "EV1",
      scoreboardFrozen: true,
      entries: [],
    };
    render(<ScoreboardPage config={config} />);

    expect(screen.getByText("scoreboard.frozen_header")).toBeDefined();
    expect(screen.queryByText("result_card.title")).toBeNull();
  });

  it("should keep the no_event copy participant-actionable and jargon-free in both locales (ja/en parity)", () => {
    for (const dict of [ja, en] as Array<{
      scoreboard: Record<string, string>;
      notifications: Record<string, string>;
    }>) {
      for (const key of ["no_event_header", "no_event_body"]) {
        expect(dict.scoreboard[key]).toBeTruthy();
        expect(dict.notifications[key]).toBeTruthy();
      }
      // 内部用語 (実装フェーズ番号 / 「旧式 deployment」) を参加者向けコピーに出さない。
      const copies = [
        dict.scoreboard.no_event_body,
        dict.scoreboard.no_event_header,
        dict.notifications.no_event_body,
      ].join(" ");
      expect(copies).not.toMatch(/Phase\s*1|旧式|legacy/i);
    }
    // 対処 (イベント経由で参加する) を案内していること。
    expect(ja.scoreboard.no_event_body).toContain("イベント");
    expect(en.scoreboard.no_event_body.toLowerCase()).toContain("event");
  });
});
