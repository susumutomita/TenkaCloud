/**
 * Issue #1329: Tenant Admin Console login redesign regression tests.
 *
 * The page must:
 *   - render TenkaCloud product name + sign-in button
 *   - call beginLogin on button click
 *   - show signing-in state after click
 *   - show error fallback when beginLogin throws
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beginLoginMock = vi.fn();
vi.mock("@tenkacloud/auth-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    beginLogin: beginLoginMock,
    beginLogout: vi.fn(),
  };
});

const { AuthProvider } = await import("../../src/auth/AuthProvider");
const { LoginPage } = await import("../../src/pages/Login");
const { I18nProvider } = await import("../../src/i18n");

import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Shared Pooled Tenant",
  apiBaseUrl: "https://api.example.com/prod",
};

function renderLogin() {
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  return render(
    <I18nProvider>
      <AuthProvider config={config}>
        <LoginPage />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("application-admin-console LoginPage (#1329)", () => {
  beforeEach(() => {
    beginLoginMock.mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should render the TenkaCloud product name and sign-in button", () => {
    renderLogin();
    expect(
      screen.getByRole("heading", { level: 1, name: /TenkaCloud Application Admin Console/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "サインイン" })).toBeInTheDocument();
  });

  it("should call beginLogin when the sign-in button is clicked", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
  });

  it("should show the signing-in state after the sign-in button is clicked", async () => {
    let resolveLogin: (() => void) | undefined;
    beginLoginMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    expect(await screen.findByText(/Cognito にリダイレクト中/)).toBeInTheDocument();
    resolveLogin?.();
  });

  it("should show the error fallback when beginLogin throws", async () => {
    beginLoginMock.mockRejectedValue(new Error("PKCE generation failed"));
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    expect(await screen.findByText(/サインインに失敗しました/)).toBeInTheDocument();
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });
});
