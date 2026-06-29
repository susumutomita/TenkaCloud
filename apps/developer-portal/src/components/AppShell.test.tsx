import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

afterEach(cleanup);

describe("AppShell accessibility", () => {
  it("should provide the core landmarks (banner, main, contentinfo, primary nav)", () => {
    render(
      <AppShell>
        <h1>Page</h1>
      </AppShell>,
    );
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("should provide a skip link that targets the main content landmark", () => {
    render(
      <AppShell>
        <h1>Page</h1>
      </AppShell>,
    );
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("should wrap arbitrary route content in the single shared shell", () => {
    render(
      <AppShell>
        <p>Docs surface content</p>
      </AppShell>,
    );
    // The same banner/footer wrap whatever child route is rendered.
    expect(screen.getByText("Docs surface content")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});
