import { afterEach, describe, expect, it } from "vitest";
import { isDemoMode, loadConfig } from "./config";

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("isDemoMode (#1954)", () => {
  it("should be true when VITE_DEMO_MODE=1 (build-time flag)", () => {
    expect(isDemoMode({ VITE_DEMO_MODE: "1" })).toBe(true);
  });

  it("should be true when ?demo=1 is in the URL", () => {
    window.history.pushState({}, "", "/?demo=1");
    expect(isDemoMode({})).toBe(true);
  });

  it("should be false without the flag or the param", () => {
    window.history.pushState({}, "", "/events");
    expect(isDemoMode({})).toBe(false);
  });
});

describe("loadConfig demo mode (#1954)", () => {
  it("should return a no-AWS demo config without reading runtime-config or env vars", async () => {
    const cfg = await loadConfig({ VITE_DEMO_MODE: "1" });
    expect(cfg.mode).toBe("demo");
    expect(cfg.tenantName).toBe("Demo Tenant");
    expect(cfg.apiBaseUrl).toBe("https://demo.invalid");
    expect(cfg.samlIdpDirectory).toEqual({});
    expect(cfg.features).toBeDefined();
    // default participant-demo hand-off target
    expect(cfg.participantPortalUrl).toBe("/portal-demo");
  });

  it("should let VITE_DEMO_PARTICIPANT_URL override the participant hand-off target", async () => {
    const cfg = await loadConfig({
      VITE_DEMO_MODE: "1",
      VITE_DEMO_PARTICIPANT_URL: "/demo/portal",
    });
    expect(cfg.participantPortalUrl).toBe("/demo/portal");
  });
});
