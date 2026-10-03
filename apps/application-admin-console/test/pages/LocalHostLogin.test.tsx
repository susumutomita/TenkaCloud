import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import type { AppConfig } from "../../src/config";
import { I18nProvider } from "../../src/i18n";
import { LocalHostLoginPage } from "../../src/pages/LocalHostLogin";

const origin = window.location.origin;
const config: AppConfig = {
  cognitoDomain: `${origin}/api/host`,
  cognitoClientId: "local-host",
  redirectUri: `${origin}/callback`,
  scope: "",
  tenantId: "local-host",
  tenantName: "Local host",
  apiBaseUrl: `${origin}/api`,
  samlIdpDirectory: {},
  mode: "local-host",
};
const proofKey = "tenkacloud.saml.browser-proof";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function showLogin() {
  return render(
    <StrictMode>
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <AuthProvider config={config}>
            <Routes>
              <Route path="/login" element={<LocalHostLoginPage config={config} />} />
              <Route path="/events" element={<p>Authenticated events</p>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </I18nProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
  window.history.replaceState(null, "", "/login");
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("ignores old SAML callbacks and offers only key sign-in", () => {
  window.history.replaceState(null, "", "/login#samlTicket=obsolete-receipt");
  sessionStorage.setItem(proofKey, "obsolete-browser-proof");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  showLogin();
  expect(screen.getByLabelText("Organizer key")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /SAML/u })).toBeNull();
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText("Authenticated events")).toBeNull();
});

it("exchanges one key request under StrictMode and follows the normal authenticated route", async () => {
  const fetchMock = vi.fn(async () =>
    json({
      idToken: "a.e30.c",
      accessToken: "a.e30.c",
      refreshToken: "refresh",
      expiresAt: Date.now() + 600000,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  showLogin();
  fireEvent.change(screen.getByLabelText("Organizer key"), { target: { value: "synthetic-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Authenticated events")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    `${origin}/api/host/login`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ key: "synthetic-key" }),
    }),
  );
});
