import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * LoginPage の onSubmit エラー翻訳 (EMPTY_TEAM_LOGIN_KEY / BACKEND_UNREACHABLE / その他 /
 * 非 Error) と、 backend モード (isMock=false) の info/field 出し分け、 既ログイン redirect を
 * pin する。 useAuth / useIsMock / useNavigate / useT を mock し、 userEvent で入力→submit する。
 */
const { mockAuth, mockIsMock, mockNavigate, mockLogin } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIsMock: vi.fn(),
  mockNavigate: vi.fn(),
  mockLogin: vi.fn(),
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const { LoginPage } = await import("../../src/pages/Login");
const config = { eventTitle: "Spring Cup" } as AppConfig;

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage config={config} />
    </MemoryRouter>,
  );
}

async function typeAndSubmit(key: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), key);
  await user.click(screen.getByRole("button", { name: "login.submit" }));
}

afterEach(() => vi.clearAllMocks());

describe("LoginPage", () => {
  it("should redirect home when already authenticated", () => {
    mockIsMock.mockReturnValue(true);
    mockAuth.mockReturnValue({ ready: true, session: { teamId: "t1" }, login: mockLogin });
    renderLogin();
    // Navigate redirect → ログインフォームは描画されない。
    expect(screen.queryByRole("button", { name: "login.submit" })).not.toBeInTheDocument();
  });

  it("should render backend-mode info + password field when not in mock mode", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ ready: true, session: null, login: mockLogin });
    const { container } = renderLogin();
    expect(container.textContent).toContain("login.info_header");
    expect(container.textContent).toContain("login.info_body");
    // backend モードは password 入力。
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("should log in and navigate home on success", async () => {
    mockIsMock.mockReturnValue(true);
    mockAuth.mockReturnValue({ ready: true, session: null, login: mockLogin });
    mockLogin.mockResolvedValueOnce(undefined);
    renderLogin();
    await typeAndSubmit("TEAM-KEY");
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/"));
  });

  it("should translate known auth error codes and pass through others", async () => {
    mockIsMock.mockReturnValue(true);
    mockAuth.mockReturnValue({ ready: true, session: null, login: mockLogin });

    for (const [thrown, expected] of [
      [new Error("EMPTY_TEAM_LOGIN_KEY"), "home.auth_error_empty_key"],
      [new Error("BACKEND_UNREACHABLE"), "home.auth_error_backend"],
      [new Error("some other failure"), "some other failure"],
      ["non-error-throwable", "login.failed_generic"],
    ] as const) {
      mockLogin.mockRejectedValueOnce(thrown);
      const { unmount } = renderLogin();
      await typeAndSubmit("KEY");
      await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
      unmount();
    }
  });
});
