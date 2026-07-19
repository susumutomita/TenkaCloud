import { useEffect } from "react";
import { useLocation } from "react-router";

export type AnalyticsParams = Readonly<Record<string, string | number | boolean>>;

type Gtag = (command: "event", name: string, params?: AnalyticsParams) => void;

function gtag(): Gtag | undefined {
  return (window as Window & { gtag?: Gtag }).gtag;
}

/**
 * GA4 is deliberately best-effort: analytics must never block the tutorial.
 * Event parameters contain only route/problem/step identifiers — never answers,
 * flags, credentials, or free-form user input.
 */
export function trackAnalyticsEvent(name: string, params: AnalyticsParams = {}): void {
  gtag()?.("event", name, params);
}

export function trackAnalyticsEventOnce(
  key: string,
  name: string,
  params: AnalyticsParams = {},
): void {
  const storageKey = `tenkacloud.analytics.${key}`;
  try {
    if (window.sessionStorage.getItem(storageKey) === "1") return;
    window.sessionStorage.setItem(storageKey, "1");
  } catch {
    // Private browsing / storage denial should not disable anonymous measurement.
  }
  trackAnalyticsEvent(name, params);
}

export function AnalyticsRouteTracker() {
  const location = useLocation();

  useEffect(() => {
    trackAnalyticsEvent("page_view", {
      page_path: `${location.pathname}${location.search}`,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [location.pathname, location.search]);

  return null;
}
