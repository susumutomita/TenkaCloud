import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { CallbackPage } from "../src/pages/Callback";

/**
 * Issue #1418: 未テストだった admin OAuth Callback page を 100% に引き上げる。
 * code 交換 (completeLogin) の success / reject / code 欠落 / 二重交換 guard を、
 * completeLogin / useAuth / useNavigate を mock + MemoryRouter で query を与えて網羅する。
 */
const { mockCompleteLogin, mockSetTokens, mockNavigate } = vi.hoisted(() => ({
  mockCompleteLogin: vi.fn(),
  mockSetTokens: vi.fn(),
  mockNavigate: vi.fn(),
}));

// auth-client は全 mock (実 module を読み込まない → coverage scope を Callback.tsx に限定)。
vi.mock("@tenkacloud/auth-client", () => ({ completeLogin: mockCompleteLogin }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: () => ({ setTokens: mockSetTokens }) }));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const config = {} as AppConfig;

const renderAt = (query: string) =>
  render(
    <MemoryRouter initialEntries={[`/callback${query}`]}>
      <CallbackPage config={config} />
    </MemoryRouter>,
  );

afterEach(() => vi.clearAllMocks());

describe("CallbackPage", () => {
  beforeEach(() => {
    mockCompleteLogin.mockResolvedValue({
      idToken: "id",
      accessToken: "ac",
      refreshToken: "rf",
      expiresAt: 9_999_999_999_999,
    });
  });

  it("should exchange the code+state and navigate to /tenants on success", async () => {
    renderAt("?code=auth-code&state=st");
    expect(screen.getByText("サインインを確定しています…")).toBeInTheDocument();
    await waitFor(() => expect(mockSetTokens).toHaveBeenCalledTimes(1));
    expect(mockCompleteLogin).toHaveBeenCalledWith(config, "auth-code", "st");
    expect(mockNavigate).toHaveBeenCalledWith("/tenants", { replace: true });
  });

  it("should pass undefined state when the state param is absent", async () => {
    renderAt("?code=auth-code");
    await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalled());
    expect(mockCompleteLogin).toHaveBeenCalledWith(config, "auth-code", undefined);
  });

  it("should show an error when the authorization code is missing", () => {
    renderAt("");
    expect(screen.getByText("サインインに失敗しました")).toBeInTheDocument();
    expect(screen.getByText(/Authorization code/)).toBeInTheDocument();
    expect(mockCompleteLogin).not.toHaveBeenCalled();
  });

  it("should surface the error message when completeLogin rejects", async () => {
    mockCompleteLogin.mockRejectedValue(new Error("token endpoint down"));
    renderAt("?code=auth-code");
    expect(await screen.findByText("token endpoint down")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("should exchange only once even if the effect re-runs (exchangedRef guard)", async () => {
    const view = renderAt("?code=auth-code");
    await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalledTimes(1));
    // 別 config object で re-render → effect dep 変化で再実行されるが exchangedRef が弾く。
    view.rerender(
      <MemoryRouter initialEntries={["/callback?code=auth-code"]}>
        <CallbackPage config={{} as AppConfig} />
      </MemoryRouter>,
    );
    await Promise.resolve();
    expect(mockCompleteLogin).toHaveBeenCalledTimes(1);
  });
});
