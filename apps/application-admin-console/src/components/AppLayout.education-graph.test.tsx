import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ShellLayout } from "./AppLayout";

// An authenticated TenantAdmin session so the education-graph nav item's role gate passes;
// the feature flag (default OFF) is then the only thing that decides its visibility.
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ tokens: { idToken: "admin-token" }, logout: vi.fn() }),
}));
vi.mock("../auth/claims", () => ({
  decodeIdToken: () => ({ role: "TenantAdmin", email: "admin@example.com", tenantId: "t" }),
  hasTenantAdminRole: () => true,
}));

const EDUCATION_GRAPH_LINK = /education graph|教育グラフ/i;

function renderShell(educationGraphEnabled: boolean) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ShellLayout educationGraphEnabled={educationGraphEnabled}>
          <div>page content</div>
        </ShellLayout>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ShellLayout education-graph nav gating (feature flag, default OFF)", () => {
  it("should hide the 教育グラフ nav item when the flag is off (the default)", () => {
    renderShell(false);
    expect(screen.queryByText(EDUCATION_GRAPH_LINK)).not.toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("should show the 教育グラフ nav item to a TenantAdmin when the flag is on", () => {
    renderShell(true);
    expect(screen.getByText(EDUCATION_GRAPH_LINK)).toBeInTheDocument();
  });
});
