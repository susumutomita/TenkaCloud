import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BattlePreview, ChallengePreview, HeroDashboard, SsoPreview } from "./MarketingPreviews";

afterEach(cleanup);

// The marketing preview mockups are decorative chrome (aria-hidden, no live data,
// no links). They must render in both locales so the JA "/" and EN "/en/" mirrors
// stay structurally identical, and must never expose interactive links (the hero /
// catalog external-link contract is asserted against real CTAs, not these mocks).
describe("MarketingPreviews", () => {
  it("should render the hero dashboard as decorative, bilingual chrome", () => {
    const ja = render(<HeroDashboard locale="ja" />);
    expect(ja.container.querySelector(".app-window")).toHaveAttribute("aria-hidden", "true");
    expect(ja.getByText("ようこそ、ゲストさん")).toBeInTheDocument();
    cleanup();
    const en = render(<HeroDashboard locale="en" />);
    expect(en.getByText("Welcome, Guest")).toBeInTheDocument();
  });

  it("should render the Battle and Challenge previews in both locales", () => {
    for (const locale of ["ja", "en"] as const) {
      const { container } = render(
        <div>
          <BattlePreview locale={locale} />
          <ChallengePreview locale={locale} />
        </div>,
      );
      // Both panels are present and decorative.
      const panels = container.querySelectorAll(".portal-preview[aria-hidden='true']");
      expect(panels.length).toBe(2);
      cleanup();
    }
  });

  it("should render the SSO preview without any interactive links", () => {
    const { container } = render(<SsoPreview locale="en" />);
    expect(container.querySelector(".sso-preview")).toHaveAttribute("aria-hidden", "true");
    // Decorative only — it must not introduce anchors into the marketing surface.
    expect(container.querySelectorAll("a").length).toBe(0);
  });
});
