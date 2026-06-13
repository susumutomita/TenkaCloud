import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventTeamsPanel } from "../../../src/components/event-detail/EventTeamsPanel";

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;
// biome-ignore lint/suspicious/noExplicitAny: 最小 team fixture。
const detail = (teams: any[], status = "DRAFT") => ({ status, teams }) as unknown as EventDetail;

afterEach(() => vi.clearAllMocks());

describe("EventTeamsPanel", () => {
  it("should render full team rows and copy the login key", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <EventTeamsPanel
        detail={detail([
          {
            internalSlug: "team-a",
            displayName: "Alpha",
            awsAccountId: "111122223333",
            teamLoginKey: "KEY-A",
          },
        ])}
        t={t}
      />,
    );
    expect(screen.getByText("team-a")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("111122223333")).toBeInTheDocument();
    expect(screen.getByText("KEY-A")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: 'event_detail.teams_col_login_key_aria|{"slug":"team-a"}',
      }),
    );
    expect(writeText).toHaveBeenCalledWith("KEY-A");
  });

  it("should copy an invite link when participantPortalUrl is configured (#1772)", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <EventTeamsPanel
        detail={detail([{ internalSlug: "team-a", teamLoginKey: "KEY A" }])}
        participantPortalUrl="https://portal.example.com/"
        t={t}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: 'event_detail.teams_col_invite_link_aria|{"slug":"team-a"}',
      }),
    );
    expect(writeText).toHaveBeenCalledWith("https://portal.example.com/login#invite=KEY%20A");
  });

  it("should not render the invite-link button without participantPortalUrl", () => {
    render(
      <EventTeamsPanel
        detail={detail([{ internalSlug: "team-a", teamLoginKey: "KEY-A" }])}
        t={t}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: 'event_detail.teams_col_invite_link_aria|{"slug":"team-a"}',
      }),
    ).not.toBeInTheDocument();
  });

  it("should show the unset / legacy fallbacks for missing fields (collapsed for RUNNING)", () => {
    render(
      <EventTeamsPanel
        detail={detail([{ internalSlug: "team-b" }], "RUNNING")} // no displayName/account/key
        t={t}
      />,
    );
    expect(screen.getByText("event_detail.teams_col_display_name_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.teams_col_account_legacy")).toBeInTheDocument();
    expect(screen.getByText("event_detail.teams_col_login_key_legacy")).toBeInTheDocument();
  });

  it("should render the empty state for an event with no teams", () => {
    render(<EventTeamsPanel detail={detail([])} t={t} />);
    expect(screen.getByText("event_detail.teams_empty")).toBeInTheDocument();
  });
});
