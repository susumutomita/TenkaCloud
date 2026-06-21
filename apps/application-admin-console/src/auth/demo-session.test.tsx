import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";

const mock = vi.hoisted(() => ({
  auth: { ready: true, tokens: null as unknown, setTokens: vi.fn() },
}));
vi.mock("./AuthProvider", () => ({ useAuth: () => mock.auth }));

import { decodeIdToken } from "./claims";
import { DEMO_ID_TOKEN, DEMO_TOKENS, DemoSessionBootstrap } from "./demo-session";

const demoConfig = { mode: "demo" } as AppConfig;
const normalConfig = {} as AppConfig;

afterEach(() => {
  mock.auth.setTokens.mockReset();
});

describe("demo token fixtures", () => {
  it("should expose an idToken that decodes to demo operator claims", () => {
    const claims = decodeIdToken(DEMO_ID_TOKEN);
    expect(claims?.email).toBe("demo-operator@tenkacloud.example");
    expect(claims?.["custom:userRole"]).toBe("TenantAdmin");
    expect(claims?.["custom:tenantName"]).toBe("Demo Tenant");
  });

  it("should provide a non-expiring TokenSet", () => {
    expect(DEMO_TOKENS.idToken).toBe(DEMO_ID_TOKEN);
    expect(DEMO_TOKENS.accessToken).toBeTruthy();
    expect(DEMO_TOKENS.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("DemoSessionBootstrap", () => {
  it("should inject the demo session when demo mode + ready + no existing session", () => {
    mock.auth = { ready: true, tokens: null, setTokens: mock.auth.setTokens };
    render(<DemoSessionBootstrap config={demoConfig} />);
    expect(mock.auth.setTokens).toHaveBeenCalledWith(DEMO_TOKENS);
  });

  it("should do nothing outside demo mode", () => {
    mock.auth = { ready: true, tokens: null, setTokens: mock.auth.setTokens };
    render(<DemoSessionBootstrap config={normalConfig} />);
    expect(mock.auth.setTokens).not.toHaveBeenCalled();
  });

  it("should do nothing before auth is ready", () => {
    mock.auth = { ready: false, tokens: null, setTokens: mock.auth.setTokens };
    render(<DemoSessionBootstrap config={demoConfig} />);
    expect(mock.auth.setTokens).not.toHaveBeenCalled();
  });

  it("should do nothing when a session already exists", () => {
    mock.auth = { ready: true, tokens: DEMO_TOKENS, setTokens: mock.auth.setTokens };
    render(<DemoSessionBootstrap config={demoConfig} />);
    expect(mock.auth.setTokens).not.toHaveBeenCalled();
  });
});
