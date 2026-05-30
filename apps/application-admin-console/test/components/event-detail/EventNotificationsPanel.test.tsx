import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventNotificationsPanel } from "../../../src/components/event-detail/EventNotificationsPanel";

const t = (key: string) => key;
const detail = (status: string) => ({ status, teams: [] }) as unknown as EventDetail;

describe("EventNotificationsPanel", () => {
  it("should enable the send button and fire onOpen for an active event", () => {
    const onOpen = vi.fn();
    render(<EventNotificationsPanel detail={detail("RUNNING")} onOpen={onOpen} t={t} />);
    const btn = screen.getByRole("button", { name: "event_detail.notifications_send" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByText("event_detail.notifications_draft_disabled")).not.toBeInTheDocument();
  });

  it("should disable send and show the draft notice for a DRAFT event", () => {
    render(<EventNotificationsPanel detail={detail("DRAFT")} onOpen={vi.fn()} t={t} />);
    expect(screen.getByRole("button", { name: "event_detail.notifications_send" })).toBeDisabled();
    expect(screen.getByText("event_detail.notifications_draft_disabled")).toBeInTheDocument();
  });

  it("should show the teardown notice for a TEARDOWN event", () => {
    render(<EventNotificationsPanel detail={detail("TEARDOWN")} onOpen={vi.fn()} t={t} />);
    expect(
      screen.getByText("event_detail.notifications_teardown_disabled_teardown"),
    ).toBeInTheDocument();
  });

  it("should show the archived notice for an ARCHIVED event", () => {
    render(<EventNotificationsPanel detail={detail("ARCHIVED")} onOpen={vi.fn()} t={t} />);
    expect(
      screen.getByText("event_detail.notifications_teardown_disabled_archived"),
    ).toBeInTheDocument();
  });
});
