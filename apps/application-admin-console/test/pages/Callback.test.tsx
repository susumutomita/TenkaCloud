import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * CallbackPage: OAuth code → token 交換 page。 code 欠落の error / 交換成功 (setTokens +
 * navigate("/")) / 交換失敗の error alert / 二重交換防止 (exchangedRef) を pin する。
 * completeLogin / useSearchParams / useNavigate / useAuth / useT を mock。
 */
const { mockComplete, mockNav, mockSetTokens, mockParams } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockNav: vi.fn(),
  mockSetTokens: vi.fn(),
  mockParams: vi.fn(),
}));

vi.mock("@tenkacloud/auth-client", () => ({ completeLogin: mockComplete }));
vi.mock("react-router", () => ({
  useSearchParams: () => [mockParams()],
  useNavigate: () => mockNav,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: () => ({ setTokens: mockSetTokens }) }));
vi.mock("../../src/i18n", () => ({ useT: () => (k: string) => k }));

const { CallbackPage } = await import("../../src/pages/Callback");
const config = {} as AppConfig;

beforeEach(() => {
  mockNav.mockClear();
  mockSetTokens.mockClear();
  mockComplete.mockReset().mockResolvedValue({ idToken: "tok" });
  mockParams.mockReturnValue(new URLSearchParams("code=abc&state=xyz"));
});
afterEach(() => vi.clearAllMocks());

describe("CallbackPage", () => {
  it("should show an error when no code is present and not exchange", () => {
    mockParams.mockReturnValue(new URLSearchParams(""));
    render(<CallbackPage config={config} />);
    expect(screen.getByText("callback.missing_code")).toBeInTheDocument();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("should exchange the code, store tokens, and navigate home on success", async () => {
    render(<CallbackPage config={config} />);
    // 交換中は spinner。
    expect(screen.getByText("callback.confirming")).toBeInTheDocument();
    await waitFor(() => expect(mockSetTokens).toHaveBeenCalledWith({ idToken: "tok" }));
    expect(mockComplete).toHaveBeenCalledWith(config, "abc", "xyz");
    expect(mockNav).toHaveBeenCalledWith("/", { replace: true });
  });

  it("should pass undefined state when the state param is absent", async () => {
    mockParams.mockReturnValue(new URLSearchParams("code=abc"));
    render(<CallbackPage config={config} />);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith(config, "abc", undefined));
  });

  it("should show an error alert when the exchange fails", async () => {
    mockComplete.mockRejectedValue(new Error("login boom"));
    render(<CallbackPage config={config} />);
    expect(await screen.findByText("login boom")).toBeInTheDocument();
  });

  it("should not exchange twice across re-renders (exchangedRef guard)", async () => {
    const { rerender } = render(<CallbackPage config={config} />);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    // params 参照を変えて effect を再走させても exchangedRef で二重交換しない。
    mockParams.mockReturnValue(new URLSearchParams("code=def&state=xyz"));
    rerender(<CallbackPage config={config} />);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});
