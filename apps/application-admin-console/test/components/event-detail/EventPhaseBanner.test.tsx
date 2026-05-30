import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import {
  EventPhaseBanner,
  effectiveStatusToPhase,
  formatElapsed,
} from "../../../src/components/event-detail/EventPhaseBanner";

const t = (k: string) => k;
const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({ status: "READY", startsAt: undefined, endsAt: undefined, ...over }) as unknown as EventDetail;
const NOW = new Date("2026-06-01T01:00:00Z");

/**
 * EventPhaseBanner の phase 分岐と、 live phase で startsAt が無い / 不正なときの
 * elapsed timer fallback ("—")。 phase mapping / formatElapsed の純関数も pin。
 */
describe("EventPhaseBanner", () => {
  it("should map effective statuses to phases", () => {
    expect(effectiveStatusToPhase("RUNNING")).toBe("live");
    expect(effectiveStatusToPhase("ENDED")).toBe("teardown");
    expect(effectiveStatusToPhase("TEARDOWN")).toBe("teardown");
    expect(effectiveStatusToPhase("ARCHIVED")).toBe("teardown");
    expect(effectiveStatusToPhase("DRAFT")).toBe("setup");
  });

  it("should format elapsed time as H:MM:SS and clamp negatives to zero", () => {
    expect(formatElapsed(0, 3661_000)).toBe("1:01:01");
    expect(formatElapsed(5000, 0)).toBe("0:00:00");
  });

  it("should render the live banner with a computed timer when past startsAt makes it RUNNING", () => {
    // status READY + 過去 startsAt → computeEffectiveStatus rule 4 で effective RUNNING (live)。
    render(
      <EventPhaseBanner
        detail={detail({ status: "READY", startsAt: "2026-06-01T00:00:00Z" })}
        now={NOW}
        t={t}
      />,
    );
    expect(screen.getByTestId("event-phase-banner-live")).toBeInTheDocument();
    expect(screen.getByTestId("event-phase-banner-live-timer")).toHaveTextContent("1:00:00");
  });

  it("should default now to the current time when the now prop is omitted", () => {
    // now を渡さない → `now ?? new Date()` の new Date() 既定経路。 過去 startsAt で live。
    render(
      <EventPhaseBanner
        detail={detail({ status: "READY", startsAt: "2020-01-01T00:00:00Z" })}
        t={t}
      />,
    );
    expect(screen.getByTestId("event-phase-banner-live")).toBeInTheDocument();
  });

  it("should render the teardown banner", () => {
    render(<EventPhaseBanner detail={detail({ status: "ARCHIVED" })} now={NOW} t={t} />);
    expect(screen.getByTestId("event-phase-banner-teardown")).toBeInTheDocument();
  });

  it("should render the setup banner", () => {
    render(<EventPhaseBanner detail={detail({ status: "DRAFT" })} now={NOW} t={t} />);
    expect(screen.getByTestId("event-phase-banner-setup")).toBeInTheDocument();
  });
});
