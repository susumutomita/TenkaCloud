import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("../src/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: mockAuth,
}));

vi.mock("../src/components/AppLayout", () => ({
  ShellLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../src/pages/Login", () => ({
  LoginPage: () => <div>login-page</div>,
}));

vi.mock("../src/pages/AuditLog", () => ({
  AuditLogPage: () => <div>audit-log-page</div>,
}));

vi.mock("../src/pages/Callback", () => ({
  CallbackPage: () => <div>callback-page</div>,
}));

vi.mock("../src/pages/IdentityProviders", () => ({
  IdentityProvidersPage: () => <div>identity-providers-page</div>,
}));

vi.mock("../src/pages/Jobs", () => ({
  JobsPage: () => <div>jobs-page</div>,
}));

vi.mock("../src/pages/Operations", () => ({
  OperationsPage: () => <div>operations-page</div>,
}));

vi.mock("../src/pages/TenantCreate", () => ({
  TenantCreatePage: () => <div>tenant-create-page</div>,
}));

vi.mock("../src/pages/TenantDetail", async () => {
  const { useParams } = await import("react-router");
  return {
    TenantDetailPage: () => {
      const { tenantId } = useParams<{ tenantId: string }>();
      return <output data-testid="tenant-id">{tenantId}</output>;
    },
  };
});

vi.mock("../src/pages/TenantList", () => ({
  TenantListPage: () => <div>tenant-list-page</div>,
}));

vi.mock("../src/pages/Usage", () => ({
  UsagePage: () => <div>usage-page</div>,
}));

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="location">
      {navigationType}:{location.pathname}
    </output>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App config={{} as AppConfig} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe("App routing", () => {
  it("should keep the current route blank while authentication is loading", () => {
    mockAuth.mockReturnValue({ ready: false, tokens: undefined });

    renderAt("/tenants/tenant%20one");

    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("POP:/tenants/tenant%20one");
  });

  it("should replace an unauthenticated tenant deep link with the login route", async () => {
    mockAuth.mockReturnValue({ ready: true, tokens: undefined });

    renderAt("/tenants/tenant%20one");

    expect(await screen.findByText("login-page")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("REPLACE:/login");
  });

  it("should route an authenticated tenant deep link with its decoded tenant id", () => {
    mockAuth.mockReturnValue({ ready: true, tokens: {} });

    renderAt("/tenants/tenant%20one");

    expect(screen.getByTestId("tenant-id")).toHaveTextContent("tenant one");
    expect(screen.getByTestId("location")).toHaveTextContent("POP:/tenants/tenant%20one");
  });
});
