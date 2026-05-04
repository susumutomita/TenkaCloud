import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  afterEach(() => sessionStorage.clear());

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

  it("prod config (= 本物 backend が必要) で login すると 'backend が未実装' で throw するべき", async () => {
    const { result } = renderAuth(prodConfig);
    await act(async () => {
      await expect(result.current.login("anything")).rejects.toThrow(/backend が未実装/);
    });
    expect(result.current.session).toBeNull();
  });

  it("Provider 外で useAuth() を呼んだら error を throw するべき", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/AuthProvider/);
  });
});
