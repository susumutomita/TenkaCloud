import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import type { TenantUserSummary } from "../../src/api/users-client";
import type { AppConfig } from "../../src/config";

const { mockUseApiClient, mockList, mockInvite, mockDelete, mockChangeRole } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockList: vi.fn(),
  mockInvite: vi.fn(),
  mockDelete: vi.fn(),
  mockChangeRole: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../src/api/users-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/users-client")>();
  return {
    ...actual,
    listTenantUsers: mockList,
    inviteTenantUser: mockInvite,
    deleteTenantUser: mockDelete,
    changeTenantUserRole: mockChangeRole,
  };
});
vi.mock("../../src/i18n", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    let out = key;
    if (params) for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v));
    return out;
  };
  return { useLang: () => "en", useT: () => t };
});

const { TenantUsersPage } = await import("../../src/pages/TenantUsers");

const config = {} as AppConfig;
const adminApi = { tenantAccess: { role: "editor", canMutateTenant: true } } as ApiClient;
const viewerApi = { tenantAccess: { role: "viewer", canMutateTenant: false } } as ApiClient;
const user = (over: Partial<TenantUserSummary> = {}): TenantUserSummary =>
  ({
    username: "alice@example.test",
    email: "alice@example.test",
    role: "TenantAdmin",
    enabled: true,
    status: "CONFIRMED",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  }) as TenantUserSummary;
const renderPage = () => render(<TenantUsersPage config={config} />);

beforeEach(() => {
  mockUseApiClient.mockReturnValue(adminApi);
  mockList.mockReset().mockResolvedValue({ items: [user()] });
  mockInvite.mockReset().mockResolvedValue({ item: user({ username: "new@example.test" }) });
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockChangeRole.mockReset().mockResolvedValue({
    item: user({ role: "TenantOperator" }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TenantUsersPage", () => {
  it("should load tenant users and render the table", async () => {
    renderPage();
    expect(await screen.findByText("alice@example.test")).toBeInTheDocument();
    expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(adminApi);
  });

  it("should invite a user with the default viewer role and refresh", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText("tenant_users.empty_header")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_submit" }));

    await waitFor(() =>
      expect(mockInvite).toHaveBeenCalledWith(adminApi, {
        email: "new@example.test",
        role: "TenantViewer",
      }),
    );
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("should validate the invite email before calling the API", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText("tenant_users.empty_header");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_submit" }));

    expect(await screen.findAllByText("tenant_users.invite_email_invalid")).not.toHaveLength(0);
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it("should delete a user after confirmation and refresh", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("alice@example.test");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.delete" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(adminApi, "alice@example.test"));
    expect(mockList).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });

  it("should change a user's role through the row selector", async () => {
    const { container } = renderPage();
    await screen.findByText("alice@example.test");
    const select = createWrapper(container).findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("TenantOperator");

    await waitFor(() =>
      expect(mockChangeRole).toHaveBeenCalledWith(adminApi, "alice@example.test", "TenantOperator"),
    );
  });

  it("should disable mutation controls for a read-only viewer", async () => {
    mockUseApiClient.mockReturnValue(viewerApi);
    renderPage();
    expect(await screen.findByText("alice@example.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "tenant_users.invite_button" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "tenant_users.delete" })).toBeDisabled();
    expect(screen.getByText("tenant_users.role_TenantAdmin")).toBeInTheDocument();
  });
});
