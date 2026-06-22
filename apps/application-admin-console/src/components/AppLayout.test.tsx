import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ShellLayout } from "./AppLayout";

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ tokens: null, logout: vi.fn() }) }));

// Locale resolves from navigator.language in the test env, so match either locale's header.
const BANNER_HEADER = /Demo mode|デモモード/;

const PARTICIPANT_LINK = /participant|参加者/i;

function renderShell(demoMode: boolean, demoParticipantUrl?: string) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ShellLayout demoMode={demoMode} demoParticipantUrl={demoParticipantUrl}>
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

  it("should offer a participant-demo hand-off link (?demo=1) when given a URL", () => {
    renderShell(true, "/portal-demo");
    const link = screen.getByRole("link", { name: PARTICIPANT_LINK });
    expect(link).toHaveAttribute("href", "/portal-demo/?demo=1");
  });

  it("should omit the participant link when no hand-off URL is provided", () => {
    renderShell(true);
    expect(screen.queryByRole("link", { name: PARTICIPANT_LINK })).not.toBeInTheDocument();
  });
});
