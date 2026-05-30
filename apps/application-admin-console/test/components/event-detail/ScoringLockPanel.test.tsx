import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { ScoringLockPanel } from "../../../src/components/event-detail/ScoringLockPanel";

/**
 * ScoringLockPanel: locale (en ↔ ja) と scoring lock 表示 (alert + badge + lockedAt 有無)。
 * useLang のみ mock し、 残り (eventStatusBadge / formatRelativeTime) は実物。
 */
const langMock = vi.fn<() => string>(() => "ja");
vi.mock("../../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/i18n")>();
  return { ...actual, useLang: () => langMock() };
});

const t = (k: string) => k;
const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    status: "READY",
    startsAt: undefined,
    endsAt: undefined,
    scoringLocked: false,
    scoringLockedAt: undefined,
    teamCount: 3,
    problems: [{}, {}],
    createdAt: "2026-05-01T00:00:00Z",
    ...over,
  }) as unknown as EventDetail;

beforeEach(() => langMock.mockReturnValue("ja"));
afterEach(() => vi.clearAllMocks());

describe("ScoringLockPanel", () => {
  it("should render the locked alert and badge with a locked-at time in English locale", () => {
    langMock.mockReturnValue("en"); // L31 の en 経路。
    render(
      <ScoringLockPanel
        detail={detail({ scoringLocked: true, scoringLockedAt: "2026-05-02T00:00:00Z" })}
        t={t}
      />,
    );
    expect(screen.getByText("event_detail.scoring_locked_header")).toBeInTheDocument();
    expect(screen.getByText("event_detail.scoring_locked_badge")).toBeInTheDocument();
    // lockedAt が truthy → locked_at 文言 (echo t なので key が出る)。
    expect(screen.getByText(/event_detail\.scoring_locked_locked_at/)).toBeInTheDocument();
  });

  it("should render the locked alert without a locked-at time", () => {
    render(
      <ScoringLockPanel
        detail={detail({ scoringLocked: true, scoringLockedAt: undefined })}
        t={t}
      />,
    );
    expect(screen.getByText("event_detail.scoring_locked_header")).toBeInTheDocument();
    expect(screen.queryByText(/scoring_locked_locked_at/)).not.toBeInTheDocument();
  });

  it("should render no lock alert when scoring is not locked", () => {
    render(<ScoringLockPanel detail={detail({ scoringLocked: false })} t={t} />);
    expect(screen.queryByText("event_detail.scoring_locked_header")).not.toBeInTheDocument();
    expect(screen.getByTestId("event-overview-summary-container")).toBeInTheDocument();
  });
});
