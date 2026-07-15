import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventTeamsPanel } from "../../../src/components/event-detail/EventTeamsPanel";

const mocks = vi.hoisted(() => ({ rotateTeamLoginKey: vi.fn() }));
vi.mock("../../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/events-client")>();
  return { ...actual, rotateTeamLoginKey: mocks.rotateTeamLoginKey };
});

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;
// biome-ignore lint/suspicious/noExplicitAny: 最小 team fixture。
const detail = (teams: any[], status = "DRAFT") => ({ status, teams }) as unknown as EventDetail;

afterEach(() => vi.clearAllMocks());

describe("EventTeamsPanel", () => {
  it("should render team metadata without pretending a one-time key can be read again", () => {
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
    expect(screen.queryByText("KEY-A")).not.toBeInTheDocument();
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
  });

  it("should render the empty state for an event with no teams", () => {
    render(<EventTeamsPanel detail={detail([])} t={t} />);
    expect(screen.getByText("event_detail.teams_empty")).toBeInTheDocument();
  });

  it("should rotate a team key and expose the replacement only in the modal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocks.rotateTeamLoginKey.mockResolvedValue({
      kind: "ok",
      teamId: "team-1",
      teamLoginKey: "NEW-ONE-TIME-KEY",
      rotatedAt: "2026-07-15T00:00:00.000Z",
    });
    render(
      <EventTeamsPanel
        apiClient={{} as never}
        canMutateTenant
        detail={
          {
            ...detail([{ teamId: "team-1", internalSlug: "team-a" }]),
            eventId: "event-1",
          } as EventDetail
        }
        t={t}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_action" }));
    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_confirm" }));
    expect(await screen.findByText("NEW-ONE-TIME-KEY")).toBeInTheDocument();
    expect(mocks.rotateTeamLoginKey).toHaveBeenCalledWith(expect.anything(), "event-1", "team-1");
    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_copy" }));
    expect(writeText).toHaveBeenCalledWith("NEW-ONE-TIME-KEY");
    await screen.findByRole("button", { name: "event_detail.rotate_key_copied" });
    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_done" }));
    await waitFor(() => expect(screen.queryByText("NEW-ONE-TIME-KEY")).not.toBeInTheDocument());
  });

  it("should show a safe error when key rotation fails", async () => {
    mocks.rotateTeamLoginKey.mockRejectedValue(new Error("rotation failed"));
    render(
      <EventTeamsPanel
        apiClient={{} as never}
        canMutateTenant
        detail={
          {
            ...detail([{ teamId: "team-1", internalSlug: "team-a" }]),
            eventId: "event-1",
          } as EventDetail
        }
        t={t}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_action" }));
    fireEvent.click(screen.getByRole("button", { name: "event_detail.rotate_key_confirm" }));
    expect(await screen.findByText("rotation failed")).toBeInTheDocument();
  });
});
