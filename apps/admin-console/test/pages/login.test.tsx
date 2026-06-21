/**
 * System Admin (Control Plane) login — behavior regression tests after the
 * "Control Plane Login.html" design import (ConsoleAuthShell). The auth contract is
 * unchanged; only the DOM the queries target changed (title is now an h2 under the
 * stage h1, JA/EN toggle labels, the email-submit button reads "続ける", and the IdP
 * picker buttons carry a logo glyph so their accessible names are matched by regex).
 *
 * Preserved contracts:
 *   - SAML empty → auto-redirect to Cognito on mount (#1360), once under StrictMode
 *   - SAML configured → email → resolveIdp → redirect / local / picker (#1335)
 *   - error fallback with support mailto; retry via the SSO button
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beginLoginMock = vi.fn();
vi.mock("@tenkacloud/auth-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, beginLogin: beginLoginMock, beginLogout: vi.fn() };
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

const emailField = () => screen.getByLabelText(/会社のメールアドレス/);
const ERROR_TEXT = /サインイン中に問題が発生しました/; // login.error_body

describe("admin-console LoginPage (Control Plane redesign)", () => {
  beforeEach(() => beginLoginMock.mockReset());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should render the console title in the panel heading", async () => {
    // success keeps signingIn=true (no reset), so the redirect spinner stays without
    // leaving a never-resolving promise that hangs the test runner at teardown.
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    expect(
      await screen.findByRole("heading", { level: 2, name: /TenkaCloud System Admin Console/ }),
    ).toBeInTheDocument();
  });

  it("should auto-call beginLogin on mount when samlIdpDirectory is empty", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
    expect(beginLoginMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("should NOT auto-call beginLogin when samlIdpDirectory has entries", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).not.toHaveBeenCalled();
    expect(emailField()).toBeInTheDocument();
  });

  it("should show the signing-in state while auto-redirecting", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    expect(await screen.findByText(/Cognito にリダイレクト中/)).toBeInTheDocument();
  });

  it("should show the error fallback with a support mailto when beginLogin throws", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("PKCE generation failed"));
    renderLogin();
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });

  it("should not re-fire beginLogin on re-render after error", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("PKCE generation failed"));
    const { rerender } = renderLogin();
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
    rerender(
      <I18nProvider>
        <AuthProvider config={baseConfig}>
          <LoginPage config={baseConfig} />
        </AuthProvider>
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).toHaveBeenCalledTimes(1);
  });

  it("should not double-fire beginLogin under StrictMode (auto-start ref guard)", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    localStorage.setItem("tenkacloud.admin.locale", "ja");
    render(
      <StrictMode>
        <I18nProvider>
          <AuthProvider config={baseConfig}>
            <LoginPage config={baseConfig} />
          </AuthProvider>
        </I18nProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).toHaveBeenCalledTimes(1);
  });

  it("should let the user retry via the SSO button after a non-Error auto-redirect failure", async () => {
    beginLoginMock.mockRejectedValueOnce("opaque failure");
    renderLogin();
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    beginLoginMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: /サインイン/ }));
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(2));
  });

  it("should switch locale via the JA/EN toggle", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    fireEvent.click(await screen.findByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveClass("on");
  });
});

describe("admin-console LoginPage SAML flow", () => {
  beforeEach(() => beginLoginMock.mockReset());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const submitEmail = () => fireEvent.click(screen.getByRole("button", { name: /続ける/ }));

  it("should redirect to the single matching IdP for the email domain", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.change(emailField(), { target: { value: "alice@example.com" } });
    submitEmail();
    await waitFor(() =>
      expect(beginLoginMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ identityProvider: "corp-entra" }),
      ),
    );
  });

  it("should fall back to local sign-in when no IdP matches the domain", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.change(emailField(), { target: { value: "outsider@other.com" } });
    submitEmail();
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
    expect(beginLoginMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("should show the IdP picker when multiple providers serve the domain", async () => {
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] } });
    fireEvent.change(emailField(), { target: { value: "alice@example.com" } });
    submitEmail();
    expect(await screen.findByRole("button", { name: /corp-entra/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /corp-okta/ })).toBeInTheDocument();
  });

  it("should redirect to the picked IdP", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] } });
    fireEvent.change(emailField(), { target: { value: "alice@example.com" } });
    submitEmail();
    fireEvent.click(await screen.findByRole("button", { name: /corp-okta/ }));
    await waitFor(() =>
      expect(beginLoginMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ identityProvider: "corp-okta" }),
      ),
    );
  });

  it("should ignore an empty email submission", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    submitEmail();
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).not.toHaveBeenCalled();
  });

  it("should return to the email form when the IdP picker is cancelled", async () => {
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] } });
    fireEvent.change(emailField(), { target: { value: "alice@example.com" } });
    submitEmail();
    await screen.findByRole("button", { name: /corp-entra/ });
    fireEvent.click(screen.getByRole("button", { name: /別のメールアドレスを使用する/ }));
    expect(emailField()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /corp-entra/ })).not.toBeInTheDocument();
  });

  it("should surface a sign-in error inside the SAML email form", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("redirect blew up"));
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.change(emailField(), { target: { value: "outsider@other.com" } });
    submitEmail();
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });

  it("should switch locale from the SAML email view", () => {
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveClass("on");
  });
});
