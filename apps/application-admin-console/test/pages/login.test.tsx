/**
 * Tenant Admin (Application Plane) login — behavior regression tests after the
 * "Application Plane Login.html" design import (ConsoleAuthShell). Auth contract
 * unchanged; the DOM the queries target changed (title is an h2 under the stage h1,
 * email placeholder "you@company.com", JA/EN toggle, IdP-picker buttons carry a logo
 * glyph). Mocks resolve or reject-once so the auto-redirect's floating promise settles
 * (a never-resolving promise hangs the test runner at teardown).
 *
 * Preserved: SAML empty → auto-redirect once (#1360); SAML configured → email →
 * resolveIdp → redirect / local / picker (#1340); error fallback + retry.
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

function renderSaml(samlIdpDirectory: Record<string, string[]>): AppConfig {
  const samlConfig: AppConfig = { ...config, samlIdpDirectory };
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  render(
    <I18nProvider>
      <AuthProvider config={samlConfig}>
        <LoginPage config={samlConfig} />
      </AuthProvider>
    </I18nProvider>,
  );
  return samlConfig;
}

const emailField = () => screen.findByPlaceholderText("you@company.com");
const submitEmail = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
};
const ERROR_TEXT = /サインイン中に問題が発生しました/; // login.error_body

describe("application-admin-console LoginPage (Application Plane redesign)", () => {
  beforeEach(() => beginLoginMock.mockReset());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should render the console title in the panel heading", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: /TenkaCloud Application Admin Console/,
      }),
    ).toBeInTheDocument();
  });

  it("should auto-call beginLogin on mount (no intermediate click)", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
  });

  it("should show the signing-in state while auto-redirecting", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    expect(await screen.findByText(/サインイン画面に移動しています/)).toBeInTheDocument();
  });

  it("should show the error fallback with a support mailto when beginLogin throws", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("PKCE generation failed"));
    renderLogin();
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    const mailto = screen.getByRole("link", { name: /support@tenkacloud\.cloud/ });
    expect(mailto).toHaveAttribute("href", "mailto:support@tenkacloud.cloud");
  });

  it("should not re-fire beginLogin on re-render after error (#1360)", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("PKCE generation failed"));
    const { rerender } = renderLogin();
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
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

  it("should render the error fallback even when beginLogin throws a non-Error", async () => {
    beginLoginMock.mockRejectedValueOnce("string failure");
    renderLogin();
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });

  it("should auto-redirect only once under StrictMode double-mount (#1360)", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    localStorage.setItem("tenkacloud.application-admin.locale", "ja");
    render(
      <StrictMode>
        <I18nProvider>
          <AuthProvider config={config}>
            <LoginPage config={config} />
          </AuthProvider>
        </I18nProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(beginLoginMock).toHaveBeenCalledTimes(1);
  });

  it("should re-trigger sign-in from the SSO button after an auto-redirect error", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("first fail")).mockResolvedValue(undefined);
    renderLogin();
    await screen.findByText(ERROR_TEXT);
    fireEvent.click(screen.getByRole("button", { name: /サインイン/ }));
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledTimes(2));
  });

  it("should switch locale via the JA/EN toggle", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderLogin();
    fireEvent.click(await screen.findByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveClass("on");
  });

  // SAML directory → email → IdP resolution flow (#1340)

  it("should switch to the email-driven SAML flow when a provider is configured", async () => {
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
    submitEmail(await emailField(), "alice@acme.example");
    await waitFor(() =>
      expect(beginLoginMock).toHaveBeenCalledWith(samlConfig, { identityProvider: "tenant-entra" }),
    );
  });

  it("should fall back to a local sign-in when the email domain is unknown", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    const cfg = renderSaml({ "acme.example": ["tenant-entra"] });
    submitEmail(await emailField(), "bob@unknown.example");
    await waitFor(() => expect(beginLoginMock).toHaveBeenCalledWith(cfg, undefined));
  });

  it("should show an IdP picker for a multi-provider domain and redirect on pick", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    const cfg = renderSaml({ "multi.example": ["idp-a", "idp-b"] });
    submitEmail(await emailField(), "alice@multi.example");
    const pickA = await screen.findByRole("button", { name: /idp-a/ });
    expect(screen.getByRole("button", { name: /idp-b/ })).toBeInTheDocument();
    fireEvent.click(pickA);
    await waitFor(() =>
      expect(beginLoginMock).toHaveBeenCalledWith(cfg, { identityProvider: "idp-a" }),
    );
  });

  it("should return to the email form when the picker is cancelled", async () => {
    renderSaml({ "multi.example": ["idp-a", "idp-b"] });
    submitEmail(await emailField(), "alice@multi.example");
    await screen.findByRole("button", { name: /idp-a/ });
    fireEvent.click(screen.getByRole("button", { name: /別のメールアドレスを使用する/ }));
    expect(await emailField()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /idp-a/ })).not.toBeInTheDocument();
  });

  it("should ignore submit when the email is empty", async () => {
    beginLoginMock.mockResolvedValue(undefined);
    renderSaml({ "acme.example": ["tenant-entra"] });
    const input = await emailField();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 10));
    expect(beginLoginMock).not.toHaveBeenCalled();
  });

  it("should show the error fallback when beginLogin throws in the SAML flow", async () => {
    beginLoginMock.mockRejectedValueOnce(new Error("SAML boom"));
    renderSaml({ "acme.example": ["tenant-entra"] });
    submitEmail(await emailField(), "alice@acme.example");
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
  });

  it("should switch locale from the SAML email view", () => {
    renderSaml({ "acme.example": ["tenant-entra"] });
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveClass("on");
  });
});
