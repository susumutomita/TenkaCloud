import type { AppMode } from "./config";

export const TENKACLOUD_GA_MEASUREMENT_ID = "G-6WQ914PCKT";

type GtagCommand = "config" | "event" | "js";
type Gtag = (command: GtagCommand, target: string | Date, params?: Record<string, unknown>) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

export type OnboardingAnalyticsEvent =
  | "onboarding_view"
  | "onboarding_step_view"
  | "onboarding_hint_reveal"
  | "onboarding_submit"
  | "onboarding_step_complete"
  | "onboarding_complete";

/**
 * GA4 は公開ブラウザ体験版だけで読み込む。本番の競技参加者ポータルへ、
 * イベント内の操作や回答値を送らない。
 */
export function initializeBrowserDemoAnalytics({
  mode,
  production,
  documentRef = document,
  windowRef = window,
}: {
  mode: AppMode;
  production: boolean;
  documentRef?: Document;
  windowRef?: Window;
}): boolean {
  if (mode !== "dev-mock" || !production) return false;
  if (windowRef.gtag) return true;

  windowRef.dataLayer = windowRef.dataLayer ?? [];
  windowRef.gtag = (...args) => {
    windowRef.dataLayer?.push(args);
  };
  windowRef.gtag("js", new Date());
  windowRef.gtag("config", TENKACLOUD_GA_MEASUREMENT_ID);

  if (!documentRef.querySelector(`script[data-tenkacloud-ga="${TENKACLOUD_GA_MEASUREMENT_ID}"]`)) {
    const script = documentRef.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${TENKACLOUD_GA_MEASUREMENT_ID}`;
    script.dataset.tenkacloudGa = TENKACLOUD_GA_MEASUREMENT_ID;
    documentRef.head.append(script);
  }
  return true;
}

export function trackOnboardingEvent(
  name: OnboardingAnalyticsEvent,
  params: Readonly<Record<string, string | number>>,
): void {
  window.gtag?.("event", name, { ...params });
}
