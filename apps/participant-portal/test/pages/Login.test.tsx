import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * LoginPage (design import "Login Screen.html") の挙動 pin。
 * 二段組 (brand stage + form) / 言語トグル / reveal トグル / mock|backend 出し分け /
 * 空キー client error / 実 auth.login 成功 → done → home 遷移 / login 失敗の翻訳 /
 * reset / live board ticker / 招待 prefill / 既ログイン redirect を網羅する。
 */
const { mockAuth, mockIsMock, mockNavigate, mockLogin, mockSetLocale, mockLocale, mockReadInvite } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockIsMock: vi.fn(),
    mockNavigate: vi.fn(),
    mockLogin: vi.fn(),
    mockSetLocale: vi.fn(),
    mockLocale: vi.fn(() => "ja"),
    mockReadInvite: vi.fn(() => null as string | null),
  }));

vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ locale: mockLocale(), setLocale: mockSetLocale, t: (k: string) => k }),
}));
vi.mock("@tenkacloud/web-kit", () => ({ BrandMark: () => null }));
vi.mock("../../src/lib/invite", () => ({
  readInviteKeyFromHash: mockReadInvite,
  clearInviteHash: vi.fn(),
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const { LoginPage, translateAuthError } = await import("../../src/pages/Login");
const config = { eventTitle: "Spring Cup" } as AppConfig;

function renderLogin(over: Partial<AppConfig> = {}) {
  return render(
    <MemoryRouter>
      <LoginPage config={{ ...config, ...over }} />
    </MemoryRouter>,
  );
}

const submitBtn = () => screen.getByRole("button", { name: "login.submit" });
const keyInput = () =>
  screen.getByPlaceholderText(/login\.(field_placeholder|mock_field_placeholder)/);

beforeEach(() => {
  mockIsMock.mockReturnValue(true);
  mockLocale.mockReturnValue("ja");
  mockReadInvite.mockReturnValue(null);
  mockAuth.mockReturnValue({ ready: true, session: null, login: mockLogin });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("translateAuthError", () => {
  it("should map EMPTY_TEAM_LOGIN_KEY and BACKEND_UNREACHABLE to i18n keys", () => {
    const t = (k: string) => k;
    expect(translateAuthError(new Error("EMPTY_TEAM_LOGIN_KEY"), t)).toBe(
      "home.auth_error_empty_key",
    );
    expect(translateAuthError(new Error("BACKEND_UNREACHABLE"), t)).toBe("home.auth_error_backend");
  });
  it("should pass through other Error messages and fall back for non-Error throws", () => {
    const t = (k: string) => k;
    expect(translateAuthError(new Error("boom"), t)).toBe("boom");
    expect(translateAuthError("string failure", t)).toBe("login.failed_generic");
  });
});

describe("LoginPage", () => {
  it("should redirect home when already authenticated", () => {
    mockAuth.mockReturnValue({ ready: true, session: { teamId: "t1" }, login: mockLogin });
    renderLogin();
    expect(screen.queryByRole("button", { name: "login.submit" })).not.toBeInTheDocument();
  });

  it("should render the brand stage + form with mock-mode copy and a text field", () => {
    renderLogin();
    expect(screen.getByText("login.stage_eyebrow")).toBeInTheDocument();
    expect(screen.getByText("login.kicker")).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("type", "text");
    expect(screen.getByText("login.mock_info_header")).toBeInTheDocument();
    expect(screen.getByText("login.mock_field_description")).toBeInTheDocument();
    expect(screen.getByText("team-shogun")).toBeInTheDocument();
    expect(screen.getAllByText("Spring Cup").length).toBeGreaterThan(0);
  });

  it("should show backend-mode copy and a password field when not in mock mode", () => {
    mockIsMock.mockReturnValue(false);
    renderLogin();
    expect(keyInput()).toHaveAttribute("type", "password");
    expect(screen.getByText("login.note_lead")).toBeInTheDocument();
    expect(screen.getByText("login.field_desc")).toBeInTheDocument();
  });

  it("should toggle key visibility with the reveal button", () => {
    mockIsMock.mockReturnValue(false);
    renderLogin();
    expect(keyInput()).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "login.reveal" }));
    expect(keyInput()).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "login.hide" })).toBeInTheDocument();
  });

  it("should block submit with a client error when the key is empty", () => {
    renderLogin();
    fireEvent.submit(submitBtn().closest("form") as HTMLFormElement);
    expect(screen.getByText("login.err_empty")).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("should clear the error once the user edits the key", () => {
    renderLogin();
    fireEvent.submit(submitBtn().closest("form") as HTMLFormElement);
    expect(screen.getByText("login.err_empty")).toBeInTheDocument();
    fireEvent.change(keyInput(), { target: { value: "K" } });
    expect(screen.queryByText("login.err_empty")).not.toBeInTheDocument();
    expect(screen.getByText("login.mock_field_description")).toBeInTheDocument();
  });

  it("should log in, show the success panel, then navigate home after the delay", async () => {
    vi.useFakeTimers();
    mockLogin.mockResolvedValueOnce(undefined);
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: "TEAM-KEY" } });
    await act(async () => {
      fireEvent.click(submitBtn());
    });
    expect(mockLogin).toHaveBeenCalledWith("TEAM-KEY");
    expect(screen.getByText("login.done_h")).toBeInTheDocument();
    expect(screen.getByText("TEAM-KEY")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("should reset from the success panel back to the form", async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: "K" } });
    await act(async () => {
      fireEvent.click(submitBtn());
    });
    expect(screen.getByText("login.done_h")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "login.again" }));
    expect(screen.getByRole("button", { name: "login.submit" })).toBeInTheDocument();
  });

  it("should surface a translated error when login fails", async () => {
    mockLogin.mockRejectedValueOnce(new Error("BACKEND_UNREACHABLE"));
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: "K" } });
    await act(async () => {
      fireEvent.click(submitBtn());
    });
    expect(screen.getByText("home.auth_error_backend")).toBeInTheDocument();
  });

  it("should ignore a second submit while one is in flight", async () => {
    let resolve: (() => void) | undefined;
    mockLogin.mockReturnValueOnce(new Promise<void>((r) => (resolve = () => r())));
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: "K" } });
    const form = submitBtn().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form); // second one hits the `if (submitting) return` guard
    expect(mockLogin).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve?.();
    });
  });

  it("should switch locale from the JA/EN toggle", () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(mockSetLocale).toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(mockSetLocale).toHaveBeenCalledWith("ja");
  });

  it("should advance the decorative live board on its interval", () => {
    vi.useFakeTimers();
    renderLogin();
    expect(screen.getByText("8,420")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    // lead row gains tick * (3-0) * 7 = 21 points.
    expect(screen.getByText("8,441")).toBeInTheDocument();
  });

  it("should prefill the key from an invite hash and fall back to the stage event label", () => {
    mockReadInvite.mockReturnValue("INVITE-KEY");
    renderLogin({ eventTitle: undefined });
    expect(keyInput()).toHaveValue("INVITE-KEY");
    expect(screen.getAllByText("Open Arena").length).toBeGreaterThan(0);
  });
});
