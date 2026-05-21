import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import type { AppConfig } from "../../src/config";

const devConfig: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "Test Event",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
  cloudMode: "mock",
};

const prodConfig: AppConfig = {
  apiBaseUrl: "https://api.example.com/prod",
  eventTitle: "Test Event",
  eventRegion: "ap-northeast-1",
  mode: "backend",
  cloudMode: "real",
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

  it("should be ready=true with no session in initial state", () => {
    const { result } = renderAuth(devConfig);
    expect(result.current.ready).toBe(true);
    expect(result.current.session).toBeNull();
  });

  it("should issue a mock session on login with dev config", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await result.current.login("abc-123-team");
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.teamId).toMatch(/^team-/);
  });

  it("should throw and not change session when passed a whitespace-only key", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      // Issue #873: regex regression を回避。
      await expect(result.current.login("   ")).rejects.toMatchObject({
        message: expect.stringContaining("EMPTY_TEAM_LOGIN_KEY"),
      });
    });
    expect(result.current.session).toBeNull();
  });

  it("should issue a session without crashing for a Unicode (Japanese) key", async () => {
    const { result } = renderAuth(devConfig);
    await act(async () => {
      await result.current.login("日本語キー");
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.teamId).toMatch(/^team-/);
  });

  it("should clear the session on logout", async () => {
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

  it("backend mode: should call /portal/me with Bearer and build a session", async () => {
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

  it("backend mode: should throw PortalAuthError on 401 and not change session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { result } = renderAuth(prodConfig);
    await act(async () => {
      // Issue #873: regex regression を回避。
      await expect(result.current.login("AbCdEfGhIjKlMnOpQrStUvWx")).rejects.toMatchObject({
        message: expect.stringContaining("チームログインキーが無効"),
      });
    });
    expect(result.current.session).toBeNull();
  });

  it("should throw an error when useAuth() is called outside the Provider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/AuthProvider/);
  });

  describe("Issue #859: idle timeout (6 hours)", () => {
    it("should not logout after 5h 59min elapsed (= tolerate long idle during competition)", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderAuth(devConfig);
        await act(async () => {
          await result.current.login("abc-123-team");
        });
        expect(result.current.session).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 59 * 60 * 1000);
          await Promise.resolve();
        });
        // 6h 未満ではまだ session 維持
        expect(result.current.session).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should auto-logout after 6h of inactivity (= safety valve after competition)", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderAuth(devConfig);
        await act(async () => {
          await result.current.login("abc-123-team");
        });
        expect(result.current.session).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);
          await Promise.resolve();
        });
        expect(result.current.session).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should reset the 6h timer on user activity", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderAuth(devConfig);
        await act(async () => {
          await result.current.login("abc-123-team");
        });

        // 5h 経過 → keydown で reset → 5h 59min 経過 (合計 10h 59min) でも logout しない
        await act(async () => {
          vi.advanceTimersByTime(5 * 60 * 60 * 1000);
          await Promise.resolve();
        });
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown"));
          await Promise.resolve();
        });
        await act(async () => {
          vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 59 * 60 * 1000);
          await Promise.resolve();
        });
        expect(result.current.session).not.toBeNull();

        // 残り 1 min 進めて (= reset 後 6h 経過) logout 発火
        await act(async () => {
          vi.advanceTimersByTime(2 * 60 * 1000);
          await Promise.resolve();
        });
        expect(result.current.session).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
