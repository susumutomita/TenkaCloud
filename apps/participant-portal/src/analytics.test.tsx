import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsRouteTracker, trackAnalyticsEvent, trackAnalyticsEventOnce } from "./analytics";

describe("participant analytics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    Reflect.deleteProperty(window, "gtag");
  });

  it("tracks SPA page views without sending form values", () => {
    const gtag = vi.fn();
    Object.assign(window, { gtag });
    render(
      <MemoryRouter initialEntries={["/problems/job-1?demo=1"]}>
        <AnalyticsRouteTracker />
      </MemoryRouter>,
    );
    expect(gtag).toHaveBeenCalledWith(
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/problems/job-1?demo=1" }),
    );
  });

  it("keeps one-shot funnel milestones to one event per browser session", () => {
    const gtag = vi.fn();
    Object.assign(window, { gtag });
    trackAnalyticsEventOnce("what-is.start", "onboarding_started", {
      problem_id: "what-is-tenkacloud",
    });
    trackAnalyticsEventOnce("what-is.start", "onboarding_started", {
      problem_id: "what-is-tenkacloud",
    });
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when GA is unavailable", () => {
    expect(() => trackAnalyticsEvent("onboarding_completed")).not.toThrow();
  });
});
