import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
function stubHost(
  operation: (path: string, init?: RequestInit) => Response | Promise<Response>,
  enabled = true,
  status = 200,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), origin).pathname;
    if (path === "/api/host/bootstrap-status") return json({ bootstrapCompleted: true });
    if (path === "/api/host/saml") return json({ enabled }, status);
    return operation(path, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
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

it("keeps the browser proof for an accepted SAML redirect", async () => {
  const operation = vi.fn((_path: string, _init?: RequestInit) =>
    json({ url: "https://idp.example/sign-in" }),
  );
  stubHost(operation);
  showLogin();
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with SAML" }));
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
  const request = operation.mock.calls[0];
  expect(request?.[0]).toBe("/api/host/saml/start");
  const body = JSON.parse(String(request?.[1]?.body)) as { browserProof: string };
  expect(body.browserProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sessionStorage.getItem(proofKey)).toBe(body.browserProof);
  expect(screen.getByRole("button", { name: "Sign in with SAML" })).toBeDisabled();
});

it.each([
  { status: 400, body: { message: "SAML paused" }, error: "SAML paused" },
  { status: 200, body: { url: 1 }, error: "SAML sign-in is unavailable." },
])(
  "clears the browser proof after a refused SAML start: $error",
  async ({ status, body, error }) => {
    stubHost(() => json(body, status));
    showLogin();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with SAML" }));
    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(sessionStorage.getItem(proofKey)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with SAML" })).toBeEnabled();
  },
);

it("hides SAML while disabled and still allows password sign-in", async () => {
  stubHost(() => json({}), false);
  showLogin();
  expect(await screen.findByLabelText("Username")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with SAML" })).toBeNull();
});

it.each([
  { lang: "en", error: "SAML status is unavailable." },
  { lang: "ja", error: "SAML の設定を確認できません。" },
])("reports an unreadable SAML status in $lang", async ({ lang, error }) => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", lang);
  stubHost(() => json({}), false, 503);
  showLogin();
  expect(await screen.findByText(error)).toBeInTheDocument();
});

it("exchanges a browser-bound callback once under StrictMode and removes its receipt from the URL", async () => {
  window.history.replaceState(null, "", "/login#samlTicket=receipt");
  sessionStorage.setItem(proofKey, "original-browser-proof");
  const operation = vi.fn((_path: string, _init?: RequestInit) =>
    json({
      idToken: "a.e30.c",
      accessToken: "a.e30.c",
      refreshToken: "refresh",
      expiresAt: Date.now() + 600000,
    }),
  );
  stubHost(operation);
  showLogin();
  expect(await screen.findByText("Authenticated events")).toBeInTheDocument();
  expect(operation).toHaveBeenCalledTimes(1);
  expect(operation.mock.calls[0]?.[0]).toBe("/api/host/saml/complete");
  expect(JSON.parse(String(operation.mock.calls[0]?.[1]?.body))).toEqual({
    ticket: "receipt",
    browserProof: "original-browser-proof",
  });
  expect(sessionStorage.getItem(proofKey)).toBeNull();
  expect(window.location.hash).toBe("");
});

it.each([
  { lang: "en", error: "Start SAML sign-in again from this browser." },
  { lang: "ja", error: "このブラウザから SAML ログインをやり直してください。" },
])("rejects a callback without this browser's proof in $lang", async ({ lang, error }) => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", lang);
  window.history.replaceState(null, "", "/login#samlTicket=receipt");
  const operation = vi.fn(() => json({}));
  stubHost(operation);
  showLogin();
  expect(await screen.findByText(error)).toBeInTheDocument();
  expect(operation).not.toHaveBeenCalled();
  expect(window.location.hash).toBe("");
});

it("shows a rejected receipt without authenticating or retaining proof", async () => {
  window.history.replaceState(null, "", "/login#samlTicket=receipt");
  sessionStorage.setItem(proofKey, "original-browser-proof");
  const operation = vi.fn(() => json({ message: "Receipt expired" }, 401));
  stubHost(operation);
  showLogin();
  expect(await screen.findByText("Receipt expired")).toBeInTheDocument();
  expect(screen.queryByText("Authenticated events")).toBeNull();
  expect(operation).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(proofKey)).toBeNull();
  expect(window.location.hash).toBe("");
});
