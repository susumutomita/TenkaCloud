/**
 * Issue #859: idle session 自動ログアウトの regression test (application-admin-console)。
 *
 * 15 分間 mouse / keyboard 操作が無ければ logout を発火することを timer mock で pin。
 *
 * tokens は memory (React state) のみで保持し sessionStorage には残さないため、
 * テストは Callback 相当の `setTokens` でログイン状態を作る。logout は revoke 対象として
 * 現在の TokenSet を beginLogout に渡す。
 */

import type { TokenSet } from "@tenkacloud/auth-client";
import { render, screen } from "@testing-library/react";
import { act, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beginLogoutMock = vi.fn();
vi.mock("@tenkacloud/auth-client", async (importOriginal) => {
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
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Shared Pooled Tenant",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

const validTokens: TokenSet = {
  idToken: "id",
  accessToken: "ac",
  refreshToken: "rf",
  expiresAt: Date.now() + 60 * 60 * 1000,
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

/** Callback 相当: mount 直後に一度だけ setTokens してログイン状態を作る (memory 保持)。 */
function SignedIn({ tokens }: { tokens: TokenSet }) {
  const { setTokens } = useAuth();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    setTokens(tokens);
  }, [setTokens, tokens]);
  return <TokensDisplay />;
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

  it("should not start the idle timer when there are no tokens", async () => {
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
    expect(beginLogoutMock).not.toHaveBeenCalled();
  });

  it("should call beginLogout with the current tokens when 15 min pass without activity", async () => {
    render(
      <AuthProvider config={config}>
        <SignedIn tokens={validTokens} />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("tokens")).toHaveTextContent("has-tokens");

    await act(async () => {
      vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).not.toHaveBeenCalled();

    // revoke 対象の TokenSet が渡る
    await act(async () => {
      vi.advanceTimersByTime(2 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).toHaveBeenCalledTimes(1);
    expect(beginLogoutMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ idToken: "id", refreshToken: "rf" }),
    );
  });

  it("should reset the idle timer on user activity (keydown)", async () => {
    render(
      <AuthProvider config={config}>
        <SignedIn tokens={validTokens} />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("tokens")).toHaveTextContent("has-tokens");

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

    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
    });
    expect(beginLogoutMock).toHaveBeenCalledTimes(1);
  });
});

describe("useAuth guard", () => {
  it("should throw when used outside an AuthProvider", () => {
    const Bare = () => {
      useAuth();
      return null;
    };
    // provider 外で useAuth → context null → 明示 error を投げる (誤用の早期検知)。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow("useAuth must be used inside <AuthProvider>");
    spy.mockRestore();
  });
});
