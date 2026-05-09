import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import type { AppConfig } from "../../src/config";

const devConfig: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "Test Event",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
};

const prodConfig: AppConfig = {
  apiBaseUrl: "https://api.example.com/prod",
  eventTitle: "Test Event",
  eventRegion: "ap-northeast-1",
  mode: "backend",
};

const renderAuth = (config: AppConfig) =>
  renderHook(() => useAuth(), {
    wrapper: ({ children }) => <AuthProvider config={config}>{children}</AuthProvider>,
  });

describe("AuthProvider", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("初期状態は ready=true / session なしであるべき", () => {
    const { result } = renderAuth(devConfig);
    expect(result.current.ready).toBe(true);
    expect(result.current.session).toBeNull();
  });

  it("dev config で login すると mock session が発行されるべき", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await result.current.login("abc-123-team");
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.teamId).toMatch(/^team-/);
  });

  it("空白のみのキーを渡したら throw、session は変わらないべき", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await expect(result.current.login("   ")).rejects.toThrow(/チームログインキー/);
    });
    expect(result.current.session).toBeNull();
  });

  it("Unicode (日本語) のキーでもクラッシュせず session 発行できるべき", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await result.current.login("日本語キー");
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.teamId).toMatch(/^team-/);
  });

  it("logout で session が消えるべき", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await result.current.login("abc-123-team");
    });
    expect(result.current.session).not.toBeNull();
    await act(async () => {
      result.current.logout();
    });
    expect(result.current.session).toBeNull();
  });

  it("backend mode: /portal/me を Bearer 付きで叩き session を構築するべき", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            team: {
              teamName: "Alpha",
              teamNameSetByCompetitor: false,
              eventId: "EV1",
              teamId: "T1",
            },
            problems: [
              {
                jobId: "JOB1",
                problemId: "p",
                region: "ap-northeast-1",
                status: "COMPLETE",
                stackOutputs: {},
                expiresAt: 1_700_000_000,
                score: 0,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { result } = renderAuth(prodConfig);
    await act(async () => {
      await result.current.login("AbCdEfGhIjKlMnOpQrStUvWx");
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.teamId).toBe("T1");
    expect(result.current.session?.teamName).toBe("Alpha");
    expect(result.current.session?.eventId).toBe("EV1");
    expect(result.current.session?.sessionToken).toBe("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(result.current.session?.expiresAt).toBe(1_700_000_000_000);
  });

  it("backend mode: 401 で PortalAuthError を throw、session は変わらないべき", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { result } = renderAuth(prodConfig);
    await act(async () => {
      await expect(result.current.login("AbCdEfGhIjKlMnOpQrStUvWx")).rejects.toThrow(
        /チームログインキーが無効/,
      );
    });
    expect(result.current.session).toBeNull();
  });

  it("Provider 外で useAuth() を呼んだら error を throw するべき", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/AuthProvider/);
  });
});
