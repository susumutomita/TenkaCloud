import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AppConfig } from "./config";
import { I18nProvider } from "./i18n";

const config: AppConfig = {
  mode: "local-host",
  apiBaseUrl: `${window.location.origin}/api`,
  cognitoDomain: `${window.location.origin}/api/host`,
  cognitoClientId: "local-host",
  redirectUri: `${window.location.origin}/callback`,
  scope: "",
  tenantId: "local-host",
  tenantName: "Local competition",
  samlIdpDirectory: {},
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/feature-flags") return Response.json({ flags: {} });
      if (path === "/api/events") return Response.json({ items: [] });
      if (path === "/api/host/login")
        return Response.json({
          idToken: `a.${btoa(JSON.stringify({ "custom:organizerRole": "Admin" }))}.c`,
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: Date.now() + 60_000,
        });
      throw new Error(`Unexpected test request: ${path}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openConsole() {
  return render(
    <StrictMode>
      <I18nProvider>
        <BrowserRouter>
          <App config={config} />
        </BrowserRouter>
      </I18nProvider>
    </StrictMode>,
  );
}

describe("local-host console root entry", () => {
  it("opens organizer-key sign-in from the advertised root URL", async () => {
    openConsole();
    expect(await screen.findByRole("button", { name: /Sign in|サインイン/u })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });

  it("opens the events list after key sign-in and when an authenticated organizer visits root", async () => {
    openConsole();
    const submit = await screen.findByRole("button", { name: /Sign in|サインイン/u });
    for (const [id, value] of [["local-host-key", "synthetic-host-key"]]) {
      const input = document.getElementById(id);
      if (!input) throw new Error(`Missing login input ${id}`);
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.click(submit);
    expect(
      await screen.findByRole("heading", { name: /^(Events|イベント)$/u }),
    ).toBeInTheDocument();
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.pathname).toBe("/events"));
    expect(
      await screen.findByRole("heading", { name: /^(Events|イベント)$/u }),
    ).toBeInTheDocument();
  });
});
