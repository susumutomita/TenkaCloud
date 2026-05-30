import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventCreateBasicInfoSection,
  type EventCreateBasicInfoSectionProps,
} from "../../../src/pages/event-create/EventCreateBasicInfoSection";

/**
 * 基本情報 section: イベント名 + チーム数。 name/teamCount の onChange、 teamCount の
 * parseTeamCountInput (有効→通知 / 無効→no-op)、 name/teamCount の errorText 分岐を pin。
 * useT は echo、 helpers は実物。
 */
vi.mock("../../../src/i18n", () => ({ useT: () => (k: string) => k }));

const props = (
  over: Partial<EventCreateBasicInfoSectionProps> = {},
): EventCreateBasicInfoSectionProps => ({
  name: "Ev",
  onNameChange: vi.fn(),
  nameInvalid: false,
  teamCount: 3,
  onTeamCountChange: vi.fn(),
  teamCountInvalid: false,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateBasicInfoSection", () => {
  it("should emit name and team-count changes", () => {
    const p = props();
    render(<EventCreateBasicInfoSection {...p} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New Name" } });
    expect(p.onNameChange).toHaveBeenCalledWith("New Name");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    expect(p.onTeamCountChange).toHaveBeenCalledWith(5);
  });

  it("should not emit a team-count change for an unparseable value", () => {
    const p = props();
    render(<EventCreateBasicInfoSection {...p} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    expect(p.onTeamCountChange).not.toHaveBeenCalled();
  });

  it("should show the name error only when invalid and non-empty", () => {
    const { rerender } = render(
      <EventCreateBasicInfoSection {...props({ name: "x", nameInvalid: true })} />,
    );
    expect(screen.getByText("event_create.name_invalid")).toBeInTheDocument();
    rerender(<EventCreateBasicInfoSection {...props({ name: "", nameInvalid: true })} />);
    expect(screen.queryByText("event_create.name_invalid")).not.toBeInTheDocument();
  });

  it("should show the team-count error when invalid", () => {
    render(<EventCreateBasicInfoSection {...props({ teamCountInvalid: true })} />);
    expect(screen.getByText("event_create.team_count_invalid")).toBeInTheDocument();
  });
});
