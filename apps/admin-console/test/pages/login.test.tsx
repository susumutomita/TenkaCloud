/**
 * Issue #1329: System Admin Console login redesign regression tests.
 *
 * The page must:
 *   - render TenkaCloud product name + sign-in button (= LP branding, not "Admin Console" alone)
 *   - call beginLogin on button click (= contract preserved across the redesign)
 *   - show signing-in state after click (= no fire-and-forget UX)
 *   - show error fallback when beginLogin throws (= support contact + mailto)
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

const baseConfig: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5173/callback",
  apiBaseUrl: "https://api.example.com",
  scope: "openid email",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "",
  cloudWatchDashboardName: "",
  samlIdpDirectory: {},
};

function renderLogin(overrides: Partial<AppConfig> = {}) {
  // pin Japanese locale so assertions are stable under jsdom (= navigator.language defaults).
  localStorage.setItem("tenkacloud.admin.locale", "ja");
  const config: AppConfig = { ...baseConfig, ...overrides };
  return render(
    <I18nProvider>
      <AuthProvider config={config}>
        <LoginPage config={config} />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("admin-console LoginPage (#1329)", () => {
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
      screen.getByRole("heading", { level: 1, name: /TenkaCloud System Admin Console/ }),
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
    // hold the promise open so the spinner state is observable.
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
    // mailto link presence: support@tenkacloud.cloud
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });
});

describe("admin-console LoginPage SAML flow (#1335)", () => {
  beforeEach(() => {
    beginLoginMock.mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should redirect to the single matching IdP when only one provider serves the email domain", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    const emailInput = screen.getByLabelText(/会社のメールアドレス/);
    fireEvent.change(emailInput, { target: { value: "alice@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ identityProvider: "corp-entra" }),
      );
    });
  });

  it("should fall back to Cognito local sign-in when the email domain has no matching IdP", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.change(screen.getByLabelText(/会社のメールアドレス/), {
      target: { value: "outsider@other.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
    // Local sign-in path does not pass identity_provider.
    const callArgs = beginLoginMock.mock.calls[0];
    expect(callArgs?.[1]).toBeUndefined();
  });

  it("should show the IdP picker when multiple providers serve the same email domain", async () => {
    renderLogin({
      samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] },
    });
    fireEvent.change(screen.getByLabelText(/会社のメールアドレス/), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    expect(await screen.findByRole("button", { name: "corp-entra" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "corp-okta" })).toBeInTheDocument();
  });

  it("should redirect to the picked IdP when the user clicks one of the picker buttons", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({
      samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] },
    });
    fireEvent.change(screen.getByLabelText(/会社のメールアドレス/), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    fireEvent.click(await screen.findByRole("button", { name: "corp-okta" }));
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ identityProvider: "corp-okta" }),
      );
    });
  });
});
