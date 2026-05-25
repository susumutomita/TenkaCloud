/**
 * Issue #1329: Tenant Admin Console login redesign regression tests.
 *
 * The page must:
 *   - render TenkaCloud product name
 *   - call beginLogin
 *   - show signing-in state
 *   - show error fallback when beginLogin throws
 *
 * Issue #1360: application-admin-console has no SAML IdP picker, so the page must
 * auto-redirect to Cognito on mount (= no intermediate "Sign in" click).
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
  samlIdpDirectory: {},
};

function renderLogin() {
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  return render(
    <I18nProvider>
      <AuthProvider config={config}>
        <LoginPage config={config} />
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

  it("should render the TenkaCloud product name in the heading", () => {
    // hold beginLogin open so the auto-redirect spinner is visible.
    beginLoginMock.mockImplementation(() => new Promise<void>(() => {}));
    renderLogin();
    expect(
      screen.getByRole("heading", { level: 1, name: /TenkaCloud Application Admin Console/ }),
    ).toBeInTheDocument();
  });

  it("should auto-call beginLogin on mount (no intermediate click)", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
  });

  it("should show the signing-in state while auto-redirecting", async () => {
    beginLoginMock.mockImplementation(() => new Promise<void>(() => {}));
    renderLogin();
    expect(await screen.findByText(/Cognito にリダイレクト中/)).toBeInTheDocument();
  });

  it("should show the error fallback when beginLogin throws on auto-redirect", async () => {
    beginLoginMock.mockRejectedValue(new Error("PKCE generation failed"));
    renderLogin();
    expect(await screen.findByText(/サインインに失敗しました/)).toBeInTheDocument();
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });

  it("should not re-fire beginLogin on re-render after error (#1360)", async () => {
    beginLoginMock.mockRejectedValue(new Error("PKCE generation failed"));
    const { rerender } = renderLogin();
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
    rerender(
      <I18nProvider>
        <AuthProvider config={config}>
          <LoginPage config={config} />
        </AuthProvider>
      </I18nProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).toHaveBeenCalledTimes(1);
  });

  // Issue #1340 Phase 2: SAML directory が入ると Login が email 入力 → IdP 解決 flow に切り替わる。

  it("should switch to the email-driven SAML flow when samlIdpDirectory has at least one provider (#1340)", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    const samlConfig: AppConfig = {
      ...config,
      samlIdpDirectory: { "acme.example": ["tenant-entra"] },
    };
    localStorage.setItem("tenkacloud.application-admin.locale", "ja");
    render(
      <I18nProvider>
        <AuthProvider config={samlConfig}>
          <LoginPage config={samlConfig} />
        </AuthProvider>
      </I18nProvider>,
    );
    // SAML 有効時は email FormField が出る (= 旧 1-step button flow ではない / auto-redirect も走らない)。
    const emailInput = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(emailInput, { target: { value: "alice@acme.example" } });
    // Cloudscape Input の onChange shape との互換のため value 反映だけ確認 → submit。
    fireEvent.submit(emailInput.closest("form")!);
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledWith(samlConfig, { identityProvider: "tenant-entra" });
    });
  });
});
