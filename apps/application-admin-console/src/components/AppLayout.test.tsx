import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ShellLayout } from "./AppLayout";

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ tokens: null, logout: vi.fn() }) }));

// Locale resolves from navigator.language in the test env, so match either locale's header.
const BANNER_HEADER = /Demo mode|デモモード/;

function renderShell(demoMode: boolean) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ShellLayout demoMode={demoMode}>
          <div>page content</div>
        </ShellLayout>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ShellLayout demo banner (#1954)", () => {
  it("should show the always-on demo banner when demoMode is true", () => {
    renderShell(true);
    expect(screen.getByText(BANNER_HEADER)).toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("should not show the demo banner in normal mode", () => {
    renderShell(false);
    expect(screen.queryByText(BANNER_HEADER)).not.toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});
