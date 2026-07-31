import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeBrowserDemoAnalytics,
  TENKACLOUD_GA_MEASUREMENT_ID,
  trackOnboardingEvent,
} from "./onboarding-analytics";

afterEach(() => {
  delete window.gtag;
  delete window.dataLayer;
});

describe("browser demo analytics", () => {
  it("should not load GA in a backend portal or a local development build", () => {
    const documentRef = document.implementation.createHTMLDocument();
    const windowRef = {} as Window;

    expect(
      initializeBrowserDemoAnalytics({
        mode: "backend",
        production: true,
        documentRef,
        windowRef,
      }),
    ).toBe(false);
    expect(
      initializeBrowserDemoAnalytics({
        mode: "dev-mock",
        production: false,
        documentRef,
        windowRef,
      }),
    ).toBe(false);
    expect(documentRef.scripts).toHaveLength(0);
  });

  it("should initialize the existing TenkaCloud GA property once for the production demo", () => {
    const documentRef = document.implementation.createHTMLDocument();
    const windowRef = {} as Window;

    expect(
      initializeBrowserDemoAnalytics({
        mode: "dev-mock",
        production: true,
        documentRef,
        windowRef,
      }),
    ).toBe(true);
    expect(documentRef.scripts).toHaveLength(1);
    expect(documentRef.scripts[0]?.src).toBe(
      `https://www.googletagmanager.com/gtag/js?id=${TENKACLOUD_GA_MEASUREMENT_ID}`,
    );
    expect(windowRef.dataLayer).toHaveLength(2);

    expect(
      initializeBrowserDemoAnalytics({
        mode: "dev-mock",
        production: true,
        documentRef,
        windowRef,
      }),
    ).toBe(true);
    expect(documentRef.scripts).toHaveLength(1);
  });

  it("should send only the supplied event name and non-answer parameters", () => {
    const gtag = vi.fn();
    window.gtag = gtag;

    trackOnboardingEvent("onboarding_submit", {
      onboarding_variant: "step",
      onboarding_step: "read-problem",
      onboarding_result: "wrong",
      step_index: 4,
    });

    expect(gtag).toHaveBeenCalledWith("event", "onboarding_submit", {
      onboarding_variant: "step",
      onboarding_step: "read-problem",
      onboarding_result: "wrong",
      step_index: 4,
    });
  });

  it("should be a no-op before GA is initialized", () => {
    expect(() =>
      trackOnboardingEvent("onboarding_view", {
        onboarding_variant: "list",
        total_steps: 6,
      }),
    ).not.toThrow();
  });
});
