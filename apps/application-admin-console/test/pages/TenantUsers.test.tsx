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

  it("should skip the initial fetch when no api client is available", async () => {
    mockUseApiClient.mockReturnValue(null);
    renderPage();
    expect(await screen.findByText("tenant_users.loading")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
    // No client → invite button disabled (canMutateTenant(null) === false).
    expect(screen.getByRole("button", { name: "tenant_users.invite_button" })).toBeDisabled();
  });

  it("should surface a load error in an alert", async () => {
    mockList.mockRejectedValue(new Error("list forbidden"));
    renderPage();
    expect(await screen.findByText("tenant_users.load_error_header")).toBeInTheDocument();
    expect(screen.getByText("list forbidden")).toBeInTheDocument();
  });

  it("should surface an invite error inside the modal when the invite fails", async () => {
    mockList.mockResolvedValue({ items: [] });
    mockInvite.mockRejectedValue(new Error("invite denied"));
    renderPage();
    await screen.findByText("tenant_users.empty_header");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_submit" }));

    // The message renders in both the Alert and the FormField errorText.
    expect(await screen.findAllByText("invite denied")).not.toHaveLength(0);
  });

  it("should close (and reset) the invite modal via cancel while not busy", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText("tenant_users.empty_header");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "typed@example.test" },
    });
    // Cancel runs closeInvite with busy=false → setInviteOpen(false) + resetInvite().
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_cancel" }));
    // Re-opening shows a fresh form: the previously typed email was reset.
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    expect(screen.getByPlaceholderText("operator@example.com")).toHaveValue("");
  });

  it("should ignore the invite modal dismiss while an invite is in flight (busy)", async () => {
    mockList.mockResolvedValue({ items: [] });
    let resolveInvite: () => void = () => undefined;
    mockInvite.mockReturnValue(
      new Promise<{ item: TenantUserSummary }>((resolve) => {
        resolveInvite = () => resolve({ item: user({ username: "new@example.test" }) });
      }),
    );
    renderPage();
    await screen.findByText("tenant_users.empty_header");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_submit" }));

    // The pending invite has flipped busy=true (the in-flight POST started).
    await waitFor(() => expect(mockInvite).toHaveBeenCalled());
    // While busy, the X dismiss is a no-op (closeInvite early-returns): the form is NOT reset.
    createWrapper(document.body).findModal()?.findDismissButton()?.click();
    expect(screen.getByPlaceholderText("operator@example.com")).toHaveValue("new@example.test");

    resolveInvite();
    // On success handleInvite resets + refreshes; the input clears.
    await waitFor(() =>
      expect(screen.getByPlaceholderText("operator@example.com")).toHaveValue(""),
    );
  });

  it("should not delete when confirmation is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await screen.findByText("alice@example.test");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.delete" }));

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledTimes(1); // only the mount load, no refresh
    confirmSpy.mockRestore();
  });

  it("should surface a delete error in an alert", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockDelete.mockRejectedValue(new Error("delete denied"));
    renderPage();
    await screen.findByText("alice@example.test");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.delete" }));

    expect(await screen.findByText("tenant_users.mutation_error_header")).toBeInTheDocument();
    expect(screen.getByText("delete denied")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("should surface a role-change error in an alert", async () => {
    mockChangeRole.mockRejectedValue(new Error("role change denied"));
    const { container } = renderPage();
    await screen.findByText("alice@example.test");

    const select = createWrapper(container).findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("TenantOperator");

    expect(await screen.findByText("tenant_users.mutation_error_header")).toBeInTheDocument();
    expect(screen.getByText("role change denied")).toBeInTheDocument();
  });

  it("should fall back to the username when the user has no email", async () => {
    mockList.mockResolvedValue({
      items: [user({ username: "bob-no-email", email: undefined })],
    });
    renderPage();
    expect(await screen.findByText("bob-no-email")).toBeInTheDocument();
  });

  it("should render dashes / disabled status for users missing role, status, and updatedAt", async () => {
    mockUseApiClient.mockReturnValue(viewerApi);
    mockList.mockResolvedValue({
      items: [
        user({
          username: "ghost",
          email: "ghost@example.test",
          role: undefined,
          enabled: false,
          status: undefined,
          updatedAt: undefined,
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText("ghost@example.test")).toBeInTheDocument();
    // disabled user → status_disabled; missing role / updatedAt → value_dash (rendered twice).
    expect(screen.getByText("tenant_users.status_disabled")).toBeInTheDocument();
    expect(screen.getAllByText("tenant_users.value_dash")).toHaveLength(2);
  });

  it("should show the raw status text for an enabled user that reports its own status", async () => {
    mockList.mockResolvedValue({
      items: [user({ enabled: true, status: "FORCE_CHANGE_PASSWORD" })],
    });
    renderPage();
    expect(await screen.findByText("FORCE_CHANGE_PASSWORD")).toBeInTheDocument();
  });

  it("should show the default enabled status when an enabled user has no status", async () => {
    mockList.mockResolvedValue({ items: [user({ enabled: true, status: undefined })] });
    renderPage();
    expect(await screen.findByText("tenant_users.status_enabled")).toBeInTheDocument();
  });

  it("should render an empty role selector when an editable user has no recognized role", async () => {
    mockList.mockResolvedValue({
      items: [user({ role: undefined })],
    });
    const { container } = renderPage();
    await screen.findByText("alice@example.test");
    // canMutate path still renders the Select; with no role the selectedOption falls back to null.
    const select = createWrapper(container).findSelect();
    expect(select).not.toBeNull();
    expect(select?.findTrigger().getElement().textContent).not.toContain("tenant_users.role_");
  });

  it("should render an empty role selector when the role is outside the known set", async () => {
    mockList.mockResolvedValue({
      // A role value not in USER_ROLES forces roleOptions.find(...) to return undefined → `?? null`.
      items: [user({ role: "LegacyRole" as TenantUserSummary["role"] })],
    });
    const { container } = renderPage();
    await screen.findByText("alice@example.test");
    const select = createWrapper(container).findSelect();
    expect(select).not.toBeNull();
    expect(select?.findTrigger().getElement().textContent).not.toContain("tenant_users.role_");
  });

  it("should change the invite role through the modal selector", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText("tenant_users.empty_header");

    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_button" }));
    fireEvent.change(screen.getByPlaceholderText("operator@example.com"), {
      target: { value: "new@example.test" },
    });
    // The invite modal renders in a portal on document.body (outside the page container).
    const select = createWrapper(document.body).findModal()?.findContent().findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("TenantAdmin");
    fireEvent.click(screen.getByRole("button", { name: "tenant_users.invite_submit" }));

    await waitFor(() =>
      expect(mockInvite).toHaveBeenCalledWith(adminApi, {
        email: "new@example.test",
        role: "TenantAdmin",
      }),
    );
  });
});
