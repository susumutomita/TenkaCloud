import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import type {
  EventOperations,
  EventTabContentProps,
} from "../../../src/pages/event-detail/tab-content-props";
import {
  isEventTabId,
  NotificationsTab,
  ProblemsTab,
  readTabFromHash,
  ScheduleTab,
  ScoreboardTab,
  TeamsTab,
} from "../../../src/pages/event-detail/tabs";

/**
 * event-detail/tabs: tab id 判定 (isEventTabId) / URL hash からの初期 tab (readTabFromHash) と、
 * 各 thin tab wrapper (Schedule/Problems/Teams/Scoreboard/Notifications) の panel 配線・callback を
 * pin する。 子 panel は callback を expose する stub に差し替えて wiring を検証。
 */
vi.mock("../../../src/components/event-detail/EventSchedulePanel", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  EventSchedulePanel: (p: any) => (
    <div data-testid="schedule-panel">
      <button type="button" onClick={p.onEndNowSchedule}>
        end-now
      </button>
      <button type="button" onClick={p.onOpenEndsAtModal}>
        open-ends
      </button>
      <button type="button" onClick={p.onOpenScheduleModal}>
        open-schedule
      </button>
      <button type="button" onClick={p.onSaveFreezeMinutes}>
        save-freeze
      </button>
      <button type="button" onClick={p.onStartNow}>
        start-now
      </button>
      <button type="button" onClick={() => p.onUpdateFreezeMinutes("9")}>
        update-freeze
      </button>
    </div>
  ),
}));
vi.mock("../../../src/components/event-detail/EventProblemSetPanel", () => ({
  EventProblemSetPanel: () => <div data-testid="problemset-panel" />,
}));
vi.mock("../../../src/components/event-detail/EventParticipantsPanel", () => ({
  EventParticipantsPanel: () => <div data-testid="participants-panel" />,
}));
vi.mock("../../../src/components/event-detail/EventTeamsPanel", () => ({
  EventTeamsPanel: () => <div data-testid="teams-panel" />,
}));
vi.mock("../../../src/components/TeamScoreEventsPanel", () => ({
  TeamScoreEventsPanel: () => <div data-testid="score-events-panel" />,
}));
vi.mock("../../../src/components/TeamRankingPanel", () => ({
  TeamRankingPanel: () => <div data-testid="ranking-panel" />,
}));
vi.mock("../../../src/components/event-detail/EventNotificationsPanel", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  EventNotificationsPanel: (p: any) => (
    <button type="button" data-testid="notify-open" onClick={p.onOpen}>
      notify
    </button>
  ),
}));

const operations = (over: Partial<EventOperations> = {}): EventOperations =>
  ({
    endsAtInFlight: false,
    freezeMinutesInFlight: false,
    freezeMinutesInput: "",
    scheduleInFlight: null,
    handleEndNowSchedule: vi.fn(),
    setEndsAtModalOpen: vi.fn(),
    setScheduleModalOpen: vi.fn(),
    handleSaveFreezeMinutes: vi.fn(),
    handleStartNow: vi.fn(),
    setFreezeMinutesInput: vi.fn(),
    setNotifyModalOpen: vi.fn(),
    ...over,
  }) as unknown as EventOperations;
const props = (over: Partial<EventTabContentProps> = {}): EventTabContentProps =>
  ({
    apiClient: {} as never,
    canMutateTenant: true,
    config: {} as never,
    counts: {} as never,
    detail: { eventId: "e1" } as unknown as EventDetail,
    manualRefresh: vi.fn(),
    manualRefreshInFlight: false,
    operations: operations(),
    t: (k: string) => k,
    wizard: null,
    ...over,
  }) as EventTabContentProps;

afterEach(() => vi.clearAllMocks());

describe("isEventTabId", () => {
  it("should accept known tab ids and reject others", () => {
    expect(isEventTabId("schedule")).toBe(true);
    expect(isEventTabId("overview")).toBe(true);
    expect(isEventTabId("bogus")).toBe(false);
  });
});

describe("readTabFromHash", () => {
  it("should default to overview for empty / unmatched / invalid hashes", () => {
    expect(readTabFromHash("")).toBe("overview");
    expect(readTabFromHash("#other=1")).toBe("overview");
    expect(readTabFromHash("#tab=bogus")).toBe("overview");
  });

  it("should read a valid tab id from the hash (with trailing params)", () => {
    expect(readTabFromHash("#tab=schedule")).toBe("schedule");
    expect(readTabFromHash("#tab=notifications&foo=bar")).toBe("notifications");
  });
});

describe("tab wrappers", () => {
  it("should wire ScheduleTab callbacks to operations", () => {
    const ops = operations();
    render(<ScheduleTab {...props({ operations: ops })} />);
    fireEvent.click(screen.getByText("end-now"));
    expect(ops.handleEndNowSchedule).toHaveBeenCalled();
    fireEvent.click(screen.getByText("open-ends"));
    expect(ops.setEndsAtModalOpen).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("open-schedule"));
    expect(ops.setScheduleModalOpen).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("save-freeze"));
    expect(ops.handleSaveFreezeMinutes).toHaveBeenCalled();
    fireEvent.click(screen.getByText("start-now"));
    expect(ops.handleStartNow).toHaveBeenCalled();
    fireEvent.click(screen.getByText("update-freeze"));
    expect(ops.setFreezeMinutesInput).toHaveBeenCalledWith("9");
  });

  it("should render the problems and teams panels", () => {
    render(<ProblemsTab {...props()} />);
    expect(screen.getByTestId("problemset-panel")).toBeInTheDocument();
    render(<TeamsTab {...props()} />);
    expect(screen.getByTestId("participants-panel")).toBeInTheDocument();
    expect(screen.getByTestId("teams-panel")).toBeInTheDocument();
  });

  it("should render scoreboard panels only when score events exist", () => {
    const withScores = render(
      <ScoreboardTab
        {...props({ detail: { scoreEventsByTeam: { teamA: [] } } as unknown as EventDetail })}
      />,
    );
    expect(screen.getByTestId("score-events-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ranking-panel")).toBeInTheDocument();
    withScores.unmount();
    render(
      <ScoreboardTab
        {...props({ detail: { scoreEventsByTeam: undefined } as unknown as EventDetail })}
      />,
    );
    expect(screen.queryByTestId("ranking-panel")).not.toBeInTheDocument();
  });

  it("should wire NotificationsTab open to operations", () => {
    const ops = operations();
    render(<NotificationsTab {...props({ operations: ops })} />);
    fireEvent.click(screen.getByTestId("notify-open"));
    expect(ops.setNotifyModalOpen).toHaveBeenCalledWith(true);
  });
});
