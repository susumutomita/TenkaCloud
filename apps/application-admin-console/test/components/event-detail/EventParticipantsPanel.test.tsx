import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventParticipantsPanel } from "../../../src/components/event-detail/EventParticipantsPanel";
import type { AppConfig } from "../../../src/config";

const t = (key: string) => key;
const detail = (status: string) => ({ status, teams: [] }) as unknown as EventDetail;

afterEach(() => vi.clearAllMocks());

describe("EventParticipantsPanel", () => {
  it("should show the portal URL + copy button when configured (expanded for DRAFT)", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <EventParticipantsPanel
        config={{ participantPortalUrl: "https://portal.example.com" } as AppConfig}
        detail={detail("DRAFT")}
        t={t}
      />,
    );
    expect(screen.getByText("https://portal.example.com")).toBeInTheDocument();
    expect(screen.getByText("event_detail.participants_steps_header")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_detail.participants_copy_aria" }));
    expect(writeText).toHaveBeenCalledWith("https://portal.example.com");
  });

  it("should show the no-URL alert when the portal URL is absent (collapsed for RUNNING)", () => {
    render(<EventParticipantsPanel config={{} as AppConfig} detail={detail("RUNNING")} t={t} />);
    expect(screen.getByText("event_detail.participants_no_url_body")).toBeInTheDocument();
  });
});
