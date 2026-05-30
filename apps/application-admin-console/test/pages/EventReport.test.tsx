import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

/**
 * EventReport (/events/:eventId/report)。 page state (不正 id→Navigate / loading / error /
 * loaded) と、 loaded の各 section (Header / Summary / Scoreboard・ProblemBreakdown の
 * empty↔rows / Disruption の有無 / Footer)、 PrintControls (back / HTML・MD export →
 * triggerBlobDownload / print)、 cover note 編集 を pin する。 useEventDetail / 純 builder /
 * exporter / react-router / useI18n を mock、 EVENT_ID_RE は実物。
 */
const {
  mockParams,
  mockNav,
  mockUseEventDetail,
  mockSummarize,
  mockScoreboard,
  mockBreakdown,
  mockDisruptions,
  mockBuildHtml,
  mockBuildMd,
} = vi.hoisted(() => ({
  mockParams: vi.fn(),
  mockNav: vi.fn(),
  mockUseEventDetail: vi.fn(),
  mockSummarize: vi.fn(),
  mockScoreboard: vi.fn(),
  mockBreakdown: vi.fn(),
  mockDisruptions: vi.fn(),
  mockBuildHtml: vi.fn(),
  mockBuildMd: vi.fn(),
}));

vi.mock("react-router", () => ({
  useParams: () => mockParams(),
  useNavigate: () => mockNav,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));
vi.mock("../../src/api/client", () => ({ useApiClient: () => ({}) }));
vi.mock("../../src/hooks/useEventDetail", () => ({ useEventDetail: mockUseEventDetail }));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useI18n: () => ({ t: (k: string) => k, locale: "ja" }) };
});
vi.mock("../../src/lib/event-report-stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/event-report-stats")>();
  return {
    ...actual,
    summarizeEvent: mockSummarize,
    buildScoreboard: mockScoreboard,
    buildProblemBreakdown: mockBreakdown,
    buildDisruptionLog: mockDisruptions,
    formatPercent: (n: number) => `${n}%`,
  };
});
vi.mock("../../src/pages/event-report/exporters/html", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/pages/event-report/exporters/html")>();
  return { ...actual, buildEventReportHtml: mockBuildHtml };
});
vi.mock("../../src/pages/event-report/exporters/markdown", () => ({
  buildEventReportMarkdown: mockBuildMd,
}));

const { EventReportPage } = await import("../../src/pages/EventReport");

const VALID_ID = "01KQZRZSTT6EQC9JVK4FQKRKKM";
const config = { tenantName: "Acme Org" } as AppConfig;
const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    eventId: VALID_ID,
    name: "Spring Battle",
    status: "ENDED",
    startsAt: "2026-06-01T00:00:00Z",
    endsAt: "2026-06-02T00:00:00Z",
    teams: [],
    problems: [],
    scoreEventsByTeam: {},
    ...over,
  }) as unknown as EventDetail;
const SUMMARY = {
  teamCount: 3,
  participantCount: 9,
  problemCount: 2,
  totalDeployments: 6,
  successRate: 0.83,
  successfulDeployments: 5,
  failedDeployments: 1,
};
const renderPage = () => render(<EventReportPage config={config} />);

beforeEach(() => {
  mockParams.mockReturnValue({ eventId: VALID_ID });
  mockNav.mockClear();
  mockUseEventDetail.mockReturnValue({ detail: detail(), error: null });
  mockSummarize.mockReturnValue(SUMMARY);
  mockScoreboard.mockReturnValue([
    { teamId: "t1", teamName: "Alpha", rank: 1, totalScore: 100, problemsSolved: 2 },
  ]);
  mockBreakdown.mockReturnValue([
    {
      problemId: "p1",
      defaultRegion: "ap-northeast-1",
      solvedCount: 2,
      avgScore: 50,
      successfulCount: 3,
      deploymentsCount: 3,
    },
  ]);
  mockDisruptions.mockReturnValue([
    {
      occurredAt: "2026-06-01T01:00:00Z",
      teamId: "t1",
      teamName: "Alpha",
      problemId: "p1",
      source: "attack",
      points: -10,
    },
  ]);
  mockBuildHtml.mockReturnValue("<html>report</html>");
  mockBuildMd.mockReturnValue("# report");
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal("print", vi.fn());
  window.print = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EventReportPage", () => {
  it("should redirect to /events for an invalid event id", () => {
    mockParams.mockReturnValue({ eventId: "not-a-ulid" });
    renderPage();
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/events");
  });

  it("should redirect when the event id is missing", () => {
    mockParams.mockReturnValue({});
    renderPage();
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/events");
  });

  it("should show a spinner while loading", () => {
    mockUseEventDetail.mockReturnValue({ detail: null, error: null });
    renderPage();
    expect(screen.getByText("event_report.loading")).toBeInTheDocument();
  });

  it("should show an error alert when loading fails", () => {
    mockUseEventDetail.mockReturnValue({ detail: null, error: "load boom" });
    renderPage();
    expect(screen.getByText("load boom")).toBeInTheDocument();
  });

  it("should render all sections with populated rows and wire the export/print controls", () => {
    renderPage();
    expect(screen.getByText("Spring Battle")).toBeInTheDocument(); // header name
    expect(screen.getByText("Acme Org")).toBeInTheDocument(); // organizer (tenantName)
    expect(screen.getByText(VALID_ID)).toBeInTheDocument(); // event id
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0); // team (scoreboard + disruption)
    expect(screen.getByText("ap-northeast-1")).toBeInTheDocument(); // breakdown row region
    expect(screen.getByText("attack")).toBeInTheDocument(); // disruption source
    expect(screen.getByText("event_report.section_disruptions")).toBeInTheDocument(); // disruptions present

    // cover note 編集。
    fireEvent.change(screen.getByLabelText("event_report.cover_note_label"), {
      target: { value: "thanks all" },
    });

    // back / HTML export / MD export / print。
    fireEvent.click(screen.getByRole("button", { name: "event_report.back" }));
    expect(mockNav).toHaveBeenCalledWith(`/events/${VALID_ID}`);
    fireEvent.click(screen.getByTestId("event-report-download-html"));
    expect(mockBuildHtml).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("event-report-download-md"));
    expect(mockBuildMd).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("event-report-print-button"));
    expect(window.print).toHaveBeenCalled();
  });

  it("should render an em-dash schedule for missing / unparseable dates", () => {
    mockUseEventDetail.mockReturnValue({
      detail: detail({ startsAt: undefined, endsAt: "not-a-date" }),
      error: null,
    });
    renderPage();
    // formatScheduleRange = formatDate(undefined) + formatDate(invalid) = "— — —"。
    expect(screen.getByText("— — —")).toBeInTheDocument();
  });

  it("should reuse the injected print stylesheet across two concurrent report instances", () => {
    // 2 つ目の usePrintStylesheet は 1 つ目が注入した <style> を見つけて再利用する (owned=false)。
    render(
      <>
        <EventReportPage config={config} />
        <EventReportPage config={config} />
      </>,
    );
    expect(screen.getAllByText("Spring Battle").length).toBe(2);
    expect(document.querySelectorAll("#tenkacloud-event-report-print-style").length).toBe(1);
  });

  it("should render empty states and omit the disruption section when there is no data", () => {
    mockScoreboard.mockReturnValue([]);
    mockBreakdown.mockReturnValue([]);
    mockDisruptions.mockReturnValue([]);
    renderPage();
    expect(screen.getByText("event_report.scoreboard_empty")).toBeInTheDocument();
    expect(screen.getByText("event_report.problems_empty")).toBeInTheDocument();
    expect(screen.queryByText("event_report.section_disruptions")).not.toBeInTheDocument();
  });
});
