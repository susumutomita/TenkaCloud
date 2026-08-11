/**
 * Issue #1418 web-kit Stage 3: 共有 AuthProvider の regression test。
 * idle-logout (#859) / token memory 保持 / login・logout 委譲 / useAuth guard を pin。
 */

import type { CognitoOAuthConfig, TokenSet } from "@tenkacloud/auth-client";
import { render, renderHook, screen } from "@testing-library/react";
import { act, type ReactNode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beginLoginMock = vi.fn();
const beginLogoutMock = vi.fn();
vi.mock("@tenkacloud/auth-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, beginLogin: beginLoginMock, beginLogout: beginLogoutMock };
});

const { AuthProvider, useAuth } = await import("../src/auth");

const config: CognitoOAuthConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5173/callback",
  scope: "openid email",
};

const validTokens: TokenSet = {
  idToken: "id",
  accessToken: "ac",
  refreshToken: "rf",
  expiresAt: 9_999_999_999_999,
};

const IDLE_PLUS = 15 * 60 * 1000 + 1000;

const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider config={config}>{children}</AuthProvider>
);

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
    beginLoginMock.mockReset();
    beginLogoutMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should mark ready after mount and start with no tokens", async () => {
    render(
      <AuthProvider config={config}>
        <TokensDisplay />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("ready")).toHaveTextContent("ready");
    expect(screen.getByTestId("tokens")).toHaveTextContent("no-tokens");
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
    act(() => {
      vi.advanceTimersByTime(IDLE_PLUS);
    });
    expect(beginLogoutMock).not.toHaveBeenCalled();
  });

  it("should call beginLogout with the current tokens after 15 min without activity", async () => {
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

describe("AuthProvider login delegation", () => {
  beforeEach(() => beginLoginMock.mockReset());

  it("should delegate login to beginLogin with config and options", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ identityProvider: "saml-idp" });
    });
    expect(beginLoginMock).toHaveBeenCalledWith(config, { identityProvider: "saml-idp" });
  });
});

describe("useAuth guard", () => {
  it("should throw when used outside an AuthProvider", () => {
    const Bare = () => {
      useAuth();
      return null;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow("useAuth must be used inside <AuthProvider>");
    spy.mockRestore();
  });
});
