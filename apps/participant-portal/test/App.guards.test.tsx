import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RequireAuth の guard 分岐 (auth 未 ready → null / 未ログイン → /login / demo auto-login
 * 待ち → null (#2707) / チーム名未設定で requireTeamName → /setup / それ以外 → children)
 * を pin する。 統合 routing は別ファイル (App.test.tsx) が実 AuthProvider で網羅するので、
 * ここは useAuth を mock して各状態を注入する。
 */
const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("../src/auth/AuthProvider", () => ({
  useAuth: mockAuth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  };
});

const { RequireAuth } = await import("../src/auth/RequireAuth");

const child = <div data-testid="child">protected</div>;

afterEach(() => vi.clearAllMocks());

describe("RequireAuth", () => {
  it("should render nothing while auth is not ready", () => {
    mockAuth.mockReturnValue({ ready: false, session: null });
    render(<RequireAuth requireTeamName>{child}</RequireAuth>);
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
  });

  it("should redirect to /login when there is no session", () => {
    mockAuth.mockReturnValue({ ready: true, session: null, demoLoginPending: false });
    render(<RequireAuth requireTeamName>{child}</RequireAuth>);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/login");
  });

  it("should hold the route without redirecting while demo auto-login is pending (#2707)", () => {
    mockAuth.mockReturnValue({ ready: true, session: null, demoLoginPending: true });
    render(<RequireAuth requireTeamName>{child}</RequireAuth>);
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
  });

  it("should redirect to /setup when the team name is not yet set", () => {
    mockAuth.mockReturnValue({ ready: true, session: { teamNameSetByCompetitor: false } });
    render(<RequireAuth requireTeamName>{child}</RequireAuth>);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/setup");
  });

  it("should render children when authenticated with a team name set", () => {
    mockAuth.mockReturnValue({ ready: true, session: { teamNameSetByCompetitor: true } });
    render(<RequireAuth requireTeamName>{child}</RequireAuth>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("should render children without a team name when requireTeamName is false (/setup route)", () => {
    mockAuth.mockReturnValue({ ready: true, session: { teamNameSetByCompetitor: false } });
    render(<RequireAuth requireTeamName={false}>{child}</RequireAuth>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
