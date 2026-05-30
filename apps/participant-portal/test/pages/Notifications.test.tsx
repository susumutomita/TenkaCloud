import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * NotificationsPage の render 分岐: error / no-event / loading spinner / empty / 一覧
 * (info・warning severity badge + body + describeAgo)。 page を開いたら markNotificationsSeen
 * が最新 occurredAt で呼ばれる (= 未読 badge 0 化) ことも pin する。共有 hook を mock する。
 */
const { mockTeamView, mockIsMock, mockSeen } = vi.hoisted(() => ({
  mockTeamView: vi.fn(),
  mockIsMock: vi.fn(),
  mockSeen: vi.fn(),
}));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));

const { NotificationsPage } = await import("../../src/pages/Notifications");

const teamView = (over: Record<string, unknown>) => ({
  notifications: undefined,
  notificationsError: undefined,
  notificationsNoEvent: undefined,
  markNotificationsSeen: mockSeen,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("NotificationsPage", () => {
  it("should show an error alert", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue(teamView({ notificationsError: "boom" }));
    render(<NotificationsPage />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("should show a no-event info alert", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue(teamView({ notificationsNoEvent: true }));
    render(<NotificationsPage />);
    expect(screen.getByText("notifications.no_event_header")).toBeInTheDocument();
  });

  it("should show a loading spinner in backend mode (and not in mock mode)", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue(teamView({}));
    const a = render(<NotificationsPage />);
    expect(a.getByText("notifications.loading")).toBeInTheDocument();
    a.unmount();

    mockIsMock.mockReturnValue(true);
    mockTeamView.mockReturnValue(teamView({}));
    const b = render(<NotificationsPage />);
    expect(b.queryByText("notifications.loading")).not.toBeInTheDocument();
  });

  it("should show the empty state and not mark anything seen", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue(teamView({ notifications: { items: [] } }));
    render(<NotificationsPage />);
    expect(screen.getByText("notifications.empty_header")).toBeInTheDocument();
    expect(mockSeen).not.toHaveBeenCalled();
  });

  it("should render notifications with severity badges and mark the latest as seen", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue(
      teamView({
        notifications: {
          items: [
            {
              notificationId: "n1",
              severity: "warning",
              title: "Outage",
              body: "DB is down",
              occurredAt: "2026-05-21T10:00:00Z",
            },
            {
              notificationId: "n2",
              severity: "info",
              title: "Welcome",
              body: "Good luck",
              occurredAt: "2026-05-21T09:00:00Z",
            },
          ],
        },
      }),
    );
    render(<NotificationsPage />);
    expect(screen.getByText("Outage")).toBeInTheDocument();
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText("notifications.severity_warning")).toBeInTheDocument();
    expect(screen.getByText("notifications.severity_info")).toBeInTheDocument();
    // 最新 (items[0]) の occurredAt で seen 化。
    expect(mockSeen).toHaveBeenCalledWith("2026-05-21T10:00:00Z");
  });
});
