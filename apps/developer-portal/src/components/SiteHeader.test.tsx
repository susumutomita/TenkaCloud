import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PRIMARY_NAV } from "@/lib/navigation";
import { SiteHeader } from "./SiteHeader";

afterEach(cleanup);

// Simulates the three surfaces by rendering the same header the shell mounts on
// every route. Because nav comes from one model, "identical across surfaces" is a
// property of the header itself.
const SURFACES = ["landing", "docs", "api-reference"] as const;

function primaryNavLabels(): string[] {
  const nav = screen.getByRole("navigation", { name: "Primary" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("SiteHeader", () => {
  it("should render shared global navigation identically across landing, docs, and API reference", () => {
    const snapshots = SURFACES.map(() => {
      render(<SiteHeader />);
      const labels = primaryNavLabels();
      cleanup();
      return labels;
    });

    const expected = PRIMARY_NAV.map((link) => link.label);
    for (const labels of snapshots) {
      expect(labels).toEqual(expected);
    }
    // All three surfaces produced the same nav.
    expect(new Set(snapshots.map((s) => s.join("|"))).size).toBe(1);
  });

  it("should expose an API Reference link in the global nav", () => {
    render(<SiteHeader />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "API Reference" })).toHaveAttribute(
      "href",
      "/developers/api/",
    );
  });

  it("should reveal the same navigation links in the mobile menu when toggled", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    expect(screen.queryByRole("navigation", { name: "Mobile" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle navigation menu" }));

    const mobileNav = screen.getByRole("navigation", { name: "Mobile" });
    const mobileLabels = within(mobileNav)
      .getAllByRole("link")
      .map((link) => link.textContent ?? "");
    expect(mobileLabels).toEqual(PRIMARY_NAV.map((link) => link.label));
  });
});
