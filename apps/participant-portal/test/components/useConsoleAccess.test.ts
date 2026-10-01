import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../../src/api/portal-client";
import { describeOpenConsoleError, useConsoleAccess } from "../../src/components/useConsoleAccess";
import type { AppConfig } from "../../src/config";

const { teamView, auth, signin, mockMode } = vi.hoisted(() => ({
  teamView: vi.fn(),
  auth: vi.fn(),
  signin: vi.fn(),
  mockMode: vi.fn(),
}));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: teamView }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: auth }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockMode }));
vi.mock("../../src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../src/api/portal-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/api/portal-client")>()),
  getConsoleSigninUrl: signin,
}));

/**
 * describeOpenConsoleError: AWS Console を開く際の error → 表示文字列 / logout シグナルへの
 * 変換を pin する。 SsoCredentials ページと TopNavigation 常設導線 (Issue #1919) が共有する
 * 純粋関数なので、 各 error 種別の分岐を直接テストする。
 */
const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}|${JSON.stringify(vars)}` : key;

describe("describeOpenConsoleError", () => {
  it("should signal a logout on an auth error", () => {
    expect(describeOpenConsoleError(new PortalAuthError(), t)).toBe("auth_logout");
  });

  it("should render a stage-aware message on an assume-role error", () => {
    const message = describeOpenConsoleError(
      new PortalAssumeRoleError("participant_viewer", "denied"),
      t,
    );
    expect(message).toContain("sso_credentials.cli.assume_role_failed");
    expect(message).toContain("sso_credentials.cli.stage_participant_viewer");
    expect(message).toContain("denied");
  });

  it("should render a validation message with the error code", () => {
    const message = describeOpenConsoleError(new PortalValidationError("bad_input"), t);
    expect(message).toContain("sso_credentials.validation_error");
    expect(message).toContain("bad_input");
  });

  it("should stringify a generic Error", () => {
    expect(describeOpenConsoleError(new Error("network down"), t)).toBe("network down");
  });

  it("should stringify a non-Error rejection", () => {
    expect(describeOpenConsoleError("plain failure", t)).toBe("plain failure");
  });
});

describe("Console access capability guard", () => {
  const config: AppConfig = {
    apiBaseUrl: "https://api.example.test",
    eventTitle: "Synthetic",
    eventRegion: "us-east-1",
    mode: "backend",
    cloudMode: "real",
  };
  beforeEach(() => {
    auth.mockReturnValue({ session: { sessionToken: "synthetic-team-key" }, logout: vi.fn() });
    mockMode.mockReturnValue(false);
    teamView.mockReturnValue({
      view: {
        problems: [{ jobId: "job-1", provider: "aws", accessCapabilities: ["cli-credentials"] }],
      },
    });
    signin.mockReset().mockResolvedValue("https://signin.aws.amazon.com/federation?Action=login");
  });
  afterEach(() => vi.restoreAllMocks());
  it("does not call federation for CLI-only or unknown jobs", async () => {
    const { result } = renderHook(() => useConsoleAccess(config));
    await act(() => result.current.openConsole("job-1"));
    expect(result.current.error?.message).toBe("sso_credentials.aws_access_unavailable");
    await act(() => result.current.openConsole("someone-else"));
    expect(signin).not.toHaveBeenCalled();
  });
  it("rechecks a withdrawn capability after a view refresh", async () => {
    teamView.mockReturnValue({
      view: { problems: [{ jobId: "job-1", provider: "aws", accessCapabilities: ["console"] }] },
    });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { result, rerender } = renderHook(() => useConsoleAccess(config));
    await act(() => result.current.openConsole("job-1"));
    expect(signin).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    teamView.mockReturnValue({
      view: { problems: [{ jobId: "job-1", provider: "aws", accessCapabilities: [] }] },
    });
    rerender();
    await act(() => result.current.openConsole("job-1"));
    expect(signin).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
