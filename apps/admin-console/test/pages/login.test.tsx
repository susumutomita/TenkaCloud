/**
 * Issue #1329: System Admin Console login redesign regression tests.
 *
 * The page must:
 *   - render TenkaCloud product name (= LP branding, not "Admin Console" alone)
 *   - call beginLogin (= contract preserved across the redesign)
 *   - show signing-in state (= no fire-and-forget UX)
 *   - show error fallback when beginLogin throws (= support contact + mailto)
 *
 * Issue #1360: when samlIdpDirectory is empty, the page must auto-redirect to Cognito
 * on mount (= no intermediate "Sign in" click). When SAML is configured, the picker UX
 * is preserved (= existing #1335 flow).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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

  it("should render the TenkaCloud product name in the heading", () => {
    // hold beginLogin open so the spinner is visible (auto-redirect hides the button on mount).
    beginLoginMock.mockImplementation(() => new Promise<void>(() => {}));
    renderLogin();
    expect(
      screen.getByRole("heading", { level: 1, name: /TenkaCloud System Admin Console/ }),
    ).toBeInTheDocument();
  });

  it("should auto-call beginLogin on mount when samlIdpDirectory is empty", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
    // Auto-redirect path passes no identity_provider (= local sign-in).
    const callArgs = beginLoginMock.mock.calls[0];
    expect(callArgs?.[1]).toBeUndefined();
  });

  it("should NOT auto-call beginLogin when samlIdpDirectory has entries", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    // give the effect a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).not.toHaveBeenCalled();
    // Picker mode shows the email input.
    expect(screen.getByLabelText(/会社のメールアドレス/)).toBeInTheDocument();
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
    // mailto link presence: support@tenkacloud.cloud
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });

  it("should not re-fire beginLogin on re-render after error", async () => {
    beginLoginMock.mockRejectedValue(new Error("PKCE generation failed"));
    const { rerender } = renderLogin();
    await waitFor(() => {
      expect(beginLoginMock).toHaveBeenCalledTimes(1);
    });
    // Force a re-render with the same props. The auto-start guard should hold.
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
    // StrictMode は effect を mount→cleanup→mount で 2 度走らせる。 autoStartedRef が
    // 2 度目を弾く (= if (autoStartedRef.current) return) ので beginLogin は 1 回だけ。
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

  it("should let the user retry via the sign-in button after a non-Error auto-redirect failure", async () => {
    // 非 Error の reject → `err instanceof Error ? err.message : ""` の "" 経路。
    beginLoginMock.mockRejectedValueOnce("opaque failure");
    renderLogin();
    expect(await screen.findByText(/サインインに失敗しました/)).toBeInTheDocument();
    // error 後は signing-in が解け、 retry button (onSignIn) が再表示される。
    beginLoginMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(2));
  });

  it("should switch locale via the language switcher", () => {
    beginLoginMock.mockImplementation(() => new Promise<void>(() => {})); // hold open
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
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

  it("should ignore an empty email submission", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    // email 空のまま submit → onSubmitEmail の `if (!trimmed) return`。
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).not.toHaveBeenCalled();
  });

  it("should return to the email form when the IdP picker is cancelled", async () => {
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra", "corp-okta"] } });
    fireEvent.change(screen.getByLabelText(/会社のメールアドレス/), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    await screen.findByRole("button", { name: "corp-entra" });
    // cancel (onCancelPicker) → picker を畳んで email form に戻る。
    fireEvent.click(screen.getByRole("button", { name: "別のメールアドレスを使用する" }));
    expect(screen.getByLabelText(/会社のメールアドレス/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "corp-entra" })).not.toBeInTheDocument();
  });

  it("should surface a sign-in error inside the SAML email form", async () => {
    // local fallback (no matching IdP) → startLogin → beginLogin reject → SAML shell の
    // errorMessage ? <Alert> : null の Alert 経路 (cond@L188)。
    beginLoginMock.mockRejectedValueOnce(new Error("redirect blew up"));
    renderLogin({ samlIdpDirectory: { "example.com": ["corp-entra"] } });
    fireEvent.change(screen.getByLabelText(/会社のメールアドレス/), {
      target: { value: "outsider@other.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "サインイン" }));
    expect(await screen.findByText(/サインインに失敗しました/)).toBeInTheDocument();
  });
});
