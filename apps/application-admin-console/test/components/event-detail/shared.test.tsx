import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  EventDeploymentSummary,
  EventDetail,
  EventStatus,
} from "../../../src/api/events-client";
import {
  eventStatusBadge,
  Field,
  renderProblemDeployStatus,
  renderProblemJobLinks,
  scoringBadge,
} from "../../../src/components/event-detail/shared";

/**
 * event-detail/shared の表示 helper を直接 unit-test する。 eventStatusBadge (effective status) /
 * renderProblemDeployStatus (未デプロイ / 成功比 + failed・in-flight badge) / renderProblemJobLinks
 * (空 / job link + status badge) / scoringBadge (locked / ended系 / 未開始 / 予約 / active) / Field。
 * computeEffectiveStatus は実物、 t は echo。
 */
const t = (k: string) => k;
const dep = (status: EventDeploymentSummary["status"], jobId: string): EventDeploymentSummary =>
  ({ jobId, status }) as unknown as EventDeploymentSummary;

describe("eventStatusBadge", () => {
  it("should render the effective status (time-aware) as a badge", () => {
    render(
      <>
        {eventStatusBadge({
          status: "DRAFT",
          startsAt: undefined,
          endsAt: undefined,
        } as EventDetail)}
      </>,
    );
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });

  it("should compute RUNNING for a READY event currently in its window", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    render(
      <>
        {eventStatusBadge(
          {
            status: "READY",
            startsAt: "2026-06-01T00:00:00Z",
            endsAt: "2026-06-02T00:00:00Z",
          } as EventDetail,
          now,
        )}
      </>,
    );
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });
});

describe("renderProblemDeployStatus", () => {
  it("should show the undeployed hint for missing or empty deployments", () => {
    const a = render(<>{renderProblemDeployStatus(undefined, t)}</>);
    expect(screen.getByText("event_detail.deploy_status_undeployed")).toBeInTheDocument();
    a.unmount();
    render(<>{renderProblemDeployStatus([], t)}</>);
    expect(screen.getByText("event_detail.deploy_status_undeployed")).toBeInTheDocument();
  });

  it("should show the complete ratio without extra badges when all done", () => {
    const { container } = render(
      <>{renderProblemDeployStatus([dep("COMPLETE", "j1"), dep("AUTO_DELETED", "j2")], t)}</>,
    );
    expect(container.textContent).toContain("2 / 2"); // complete / total
    expect(screen.queryByText("event_detail.deploy_status_failed_badge")).not.toBeInTheDocument();
    expect(screen.queryByText("event_detail.deploy_status_in_flight")).not.toBeInTheDocument();
  });

  it("should add failed and in-flight badges when present", () => {
    render(
      <>
        {renderProblemDeployStatus(
          [
            dep("COMPLETE", "j1"),
            dep("FAILED", "j2"),
            dep("EXPIRED", "j3"),
            dep("PENDING", "j4"),
            dep("IN_PROGRESS", "j5"),
          ],
          t,
        )}
      </>,
    );
    expect(screen.getByText("event_detail.deploy_status_failed_badge")).toBeInTheDocument();
    expect(screen.getByText("event_detail.deploy_status_in_flight")).toBeInTheDocument();
  });
});

describe("renderProblemJobLinks", () => {
  it("should show an em-dash when there are no deployments", () => {
    render(<>{renderProblemJobLinks([])}</>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("should render a job link + status badge per deployment", () => {
    render(<>{renderProblemJobLinks([dep("COMPLETE", "j1"), dep("FAILED", "j2")])}</>);
    expect(screen.getByText("Job #1 ↗")).toBeInTheDocument();
    expect(screen.getByText("Job #2 ↗")).toBeInTheDocument();
    expect(screen.getByText("COMPLETE")).toBeInTheDocument();
    expect(screen.getByText("FAILED")).toBeInTheDocument();
  });
});

describe("scoringBadge", () => {
  const badge = (detail: Partial<EventDetail>) =>
    render(<>{scoringBadge(detail as EventDetail, t)}</>);

  it("should show locked when scoring is locked", () => {
    badge({ scoringLocked: true, status: "READY" });
    expect(screen.getByText("event_detail.scoring_badge_locked")).toBeInTheDocument();
  });

  it.each<EventStatus>([
    "ENDED",
    "ARCHIVED",
    "TEARDOWN",
  ])("should show ended for terminal status %s", (status) => {
    badge({ scoringLocked: false, status });
    expect(screen.getByText("event_detail.scoring_badge_ended")).toBeInTheDocument();
  });

  it("should show not-started when there is no start time", () => {
    badge({ scoringLocked: false, status: "READY", startsAt: undefined });
    expect(screen.getByText("event_detail.scoring_badge_not_started")).toBeInTheDocument();
  });

  it("should show scheduled when the start time is in the future", () => {
    badge({ scoringLocked: false, status: "READY", startsAt: "2999-01-01T00:00:00Z" });
    expect(screen.getByText("event_detail.scoring_badge_scheduled")).toBeInTheDocument();
  });

  it("should show active when the start time has passed", () => {
    badge({ scoringLocked: false, status: "READY", startsAt: "2000-01-01T00:00:00Z" });
    expect(screen.getByText("event_detail.scoring_badge_active")).toBeInTheDocument();
  });
});

describe("Field", () => {
  it("should render the label and children", () => {
    render(
      <Field label="My Label">
        <span>child-value</span>
      </Field>,
    );
    expect(screen.getByText("My Label")).toBeInTheDocument();
    expect(screen.getByText("child-value")).toBeInTheDocument();
  });
});
