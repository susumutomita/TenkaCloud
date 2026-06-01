import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalAuthError, PortalValidationError } from "../../src/api/portal-client";
import type { AppConfig } from "../../src/config";
import type { LocaleCode } from "../../src/i18n";

/**
 * TeamSetupPage の team name 入力 (新規 / edit mode / mock vs backend / 各 error) と純粋 helper
 * (describeTeamNameDraft / canSubmitTeamName / formatTeamSetupSubmitError / buildLocaleUtility) を
 * pin する。 hook と updateTeamName は mock、 Portal*Error は実物。
 */
const { mockNav, mockAuth, mockIsMock, mockLocale, mockSetLocale, mockUpdate } = vi.hoisted(() => ({
  mockNav: vi.fn(),
  mockAuth: vi.fn(),
  mockIsMock: vi.fn(),
  mockLocale: { value: "en" as LocaleCode },
  mockSetLocale: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
    useI18n: () => ({ locale: mockLocale.value, setLocale: mockSetLocale, t: (k: string) => k }),
  };
});
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return { ...actual, updateTeamName: mockUpdate };
});

const { TeamSetupPage, describeTeamNameDraft, canSubmitTeamName, formatTeamSetupSubmitError } =
  await import("../../src/pages/TeamSetup");

const config = { apiBaseUrl: "https://api.example.com", eventTitle: "Test event" } as AppConfig;
const updateSession = vi.fn();
const logout = vi.fn();

function authValue(sessionOver: Record<string, unknown> | null = {}) {
  return {
    session:
      sessionOver === null
        ? null
        : { sessionToken: "tok", teamName: "", teamNameSetByCompetitor: false, ...sessionOver },
    updateSession,
    logout,
  };
}

const renderPage = () => render(<TeamSetupPage config={config} />);
const submitButton = () =>
  screen.getByRole("button", { name: /team_setup\.(edit_)?submit_button/ });
const typeName = (value: string) =>
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  mockAuth.mockReturnValue(authValue());
  mockIsMock.mockReturnValue(false);
  mockLocale.value = "en";
  mockUpdate.mockReset();
  mockNav.mockClear();
  updateSession.mockClear();
  logout.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("pure helpers", () => {
  it("should describe a team-name draft (trim + validity)", () => {
    expect(describeTeamNameDraft("")).toEqual({ trimmed: "", invalid: false });
    expect(describeTeamNameDraft("  Valid Name  ")).toEqual({
      trimmed: "Valid Name",
      invalid: false,
    });
    expect(describeTeamNameDraft("@@@").invalid).toBe(true);
  });

  it("should gate submission on token / non-empty / valid / not-submitting", () => {
    const ok = { sessionToken: "t", trimmed: "Team", invalid: false, submitting: false };
    expect(canSubmitTeamName(ok)).toBe(true);
    expect(canSubmitTeamName({ ...ok, sessionToken: undefined })).toBe(false);
    expect(canSubmitTeamName({ ...ok, trimmed: "" })).toBe(false);
    expect(canSubmitTeamName({ ...ok, invalid: true })).toBe(false);
    expect(canSubmitTeamName({ ...ok, submitting: true })).toBe(false);
  });

  it("should format submit errors by type", () => {
    expect(formatTeamSetupSubmitError(new PortalValidationError("bad"), "invalid!")).toBe(
      "invalid!",
    );
    expect(formatTeamSetupSubmitError(new Error("boom"), "x")).toBe("boom");
    expect(formatTeamSetupSubmitError("plain", "x")).toBe("plain");
  });
});

describe("TeamSetupPage", () => {
  it("should render the new-team form without a cancel button", () => {
    renderPage();
    expect(screen.getByText("team_setup.title")).toBeInTheDocument();
    expect(submitButton()).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "team_setup.cancel_button" }),
    ).not.toBeInTheDocument();
  });

  it("should prefill and offer cancel in edit mode", () => {
    mockAuth.mockReturnValue(authValue({ teamNameSetByCompetitor: true, teamName: "Existing" }));
    renderPage();
    expect(screen.getByText("team_setup.edit_title")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Existing");
    fireEvent.click(screen.getByRole("button", { name: "team_setup.cancel_button" }));
    expect(mockNav).toHaveBeenCalledWith("/");
  });

  it("should start blank in edit mode when no team name is stored", () => {
    mockAuth.mockReturnValue(authValue({ teamNameSetByCompetitor: true, teamName: undefined }));
    renderPage();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("should show a format error and disable submit for an invalid name", () => {
    renderPage();
    typeName("@@@");
    expect(screen.getByText("team_setup.field_invalid_format")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("should submit to the backend and update the session", async () => {
    mockUpdate.mockResolvedValue({ team: { teamName: "My Team", teamNameSetByCompetitor: true } });
    renderPage();
    typeName("My Team");
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith("https://api.example.com", "tok", "My Team"),
    );
    expect(updateSession).toHaveBeenCalledWith({
      teamName: "My Team",
      teamNameSetByCompetitor: true,
    });
    expect(mockNav).toHaveBeenCalledWith("/");
  });

  it("should update the session locally without a backend call in mock mode", async () => {
    mockIsMock.mockReturnValue(true);
    renderPage();
    typeName("Mock Team");
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith({
        teamName: "Mock Team",
        teamNameSetByCompetitor: true,
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNav).toHaveBeenCalledWith("/");
  });

  it("should log out and redirect on a PortalAuthError", async () => {
    mockUpdate.mockRejectedValue(new PortalAuthError());
    renderPage();
    typeName("My Team");
    fireEvent.click(submitButton());
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(mockNav).toHaveBeenCalledWith("/login");
  });

  it("should surface a submit error alert on other failures", async () => {
    mockUpdate.mockRejectedValue(new Error("server boom"));
    renderPage();
    typeName("My Team");
    fireEvent.click(submitButton());
    expect(await screen.findByText("server boom")).toBeInTheDocument();
  });
});
