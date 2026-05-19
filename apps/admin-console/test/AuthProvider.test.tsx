/**
 * Issue #859: idle session 自動ログアウトの regression test。
 *
 * 15 分間 mouse / keyboard 操作が無ければ logout を発火することを timer mock で pin。
 */
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beginLogoutMock = vi.fn();
vi.mock("../src/auth/cognito", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    beginLogout: beginLogoutMock,
    beginLogin: vi.fn(),
  };
});

const { AuthProvider, useAuth } = await import("../src/auth/AuthProvider");

import type { AppConfig } from "../src/config";

const config: AppConfig = {
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
};

function TokensDisplay() {
  const { tokens, ready } = useAuth();
  return (
    <div>
      <span data-testid="ready">{ready ? "ready" : "not-ready"}</span>
      <span data-testid="tokens">{tokens ? "has-tokens" : "no-tokens"}</span>
    </div>
  );
}

describe("AuthProvider idle timeout (#859)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    beginLogoutMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tokens が無いときは idle timer を起動しないべき", async () => {
    render(
      <AuthProvider config={config}>
        <TokensDisplay />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("tokens")).toHaveTextContent("no-tokens");
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
    });
    // beginLogout は呼ばれない
    expect(beginLogoutMock).not.toHaveBeenCalled();
  });

  it("tokens 有りで 15 min 無操作なら beginLogout を呼ぶべき", async () => {
    const valid = {
      idToken: "id",
      accessToken: "ac",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(valid));

    render(
      <AuthProvider config={config}>
        <TokensDisplay />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("tokens")).toHaveTextContent("has-tokens");

    // 14 min 59 sec ではまだ呼ばれない
    await act(async () => {
      vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).not.toHaveBeenCalled();

    // 残り 1 sec で発火
    await act(async () => {
      vi.advanceTimersByTime(2 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).toHaveBeenCalledTimes(1);
  });

  it("user 操作 (keydown) で idle timer は reset されるべき", async () => {
    const valid = {
      idToken: "id",
      accessToken: "ac",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(valid));

    render(
      <AuthProvider config={config}>
        <TokensDisplay />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // 10 min 経過 → keydown で reset → 14 min 経過 (total 24 min) でも logout しない
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown"));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(14 * 60 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).not.toHaveBeenCalled();

    // 残り 2 min 進めれば計 26 min、 reset 後 16 min で発火
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).toHaveBeenCalledTimes(1);
  });
});
