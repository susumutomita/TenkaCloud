import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CliCredentialsView,
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../api/portal-client";

/**
 * CliCredentialsPanel (CLI/SDK 一時資格情報 panel) の取得 (success / 各 error 種別) と表示
 * (mask/reveal/copy/再発行/破棄/TTL countdown/期限切れ) を pin する。 getCliCredentials を mock、
 * Portal*Error は実物、 navigator.clipboard は stub。 純粋関数 describeRemainingTime /
 * buildShellExport は直接 unit-test する。
 */
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock("../i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, getCliCredentials: mockGet };
});

const { CliCredentialsPanel, buildShellExport, describeRemainingTime } = await import(
  "./CliCredentialsPanel"
);

const creds = (over: Partial<CliCredentialsView> = {}): CliCredentialsView => ({
  accessKeyId: "AKIAEXAMPLE12345",
  secretAccessKey: "short", // 8 文字以下 → mask の repeat 分岐
  sessionToken: "verylongsessiontokenvalue1234567890", // 8 文字超 → mask の slice 分岐
  expiration: "2999-12-31T23:59:59Z",
  region: "ap-northeast-1",
  awsAccountId: "111122223333",
  ...over,
});

const onAuthError = vi.fn();
const baseProps = {
  apiBaseUrl: "https://api.example.com",
  sessionToken: "team-key",
  jobId: "job-1",
  onAuthError,
};
const clip = vi.fn().mockResolvedValue(undefined);

function renderPanel(over: Partial<typeof baseProps> & { mockBlocked?: boolean } = {}) {
  const r = render(<CliCredentialsPanel {...baseProps} {...over} />);
  // ExpandableSection は default 折りたたみなので header を click して中身を出す。
  fireEvent.click(screen.getByRole("button", { name: /sso_credentials\.cli\.section_header/ }));
  return r;
}

const issueButton = () => screen.getByRole("button", { name: "sso_credentials.cli.issue_button" });

async function showCreds(over: Partial<CliCredentialsView> = {}, props = {}) {
  mockGet.mockResolvedValue(creds(over));
  renderPanel(props);
  fireEvent.click(issueButton());
  await screen.findByText("sso_credentials.cli.field_access_key_id");
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clip }, configurable: true });
  clip.mockClear();
  clip.mockResolvedValue(undefined);
  mockGet.mockReset();
  onAuthError.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("pure helpers", () => {
  it("should treat an unparseable expiration as expired", () => {
    expect(describeRemainingTime("not-a-date", 0)).toEqual({ kind: "expired" });
  });

  it("should treat a past expiration as expired", () => {
    expect(
      describeRemainingTime("2020-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")),
    ).toEqual({ kind: "expired" });
  });

  it("should format a future expiration as m/s remaining", () => {
    const state = describeRemainingTime(new Date(90_000).toISOString(), 0);
    expect(state).toEqual({ kind: "remaining", label: "1m 30s" });
  });

  it("should build the shell export snippet for all four variables", () => {
    const snippet = buildShellExport(creds());
    expect(snippet).toContain("export AWS_ACCESS_KEY_ID=AKIAEXAMPLE12345");
    expect(snippet).toContain("export AWS_SECRET_ACCESS_KEY=short");
    expect(snippet).toContain("export AWS_SESSION_TOKEN=verylongsessiontokenvalue1234567890");
    expect(snippet).toContain("export AWS_REGION=ap-northeast-1");
  });
});

describe("CliCredentialsPanel fetch flow", () => {
  it("should show a mock-blocked info alert and no issue button", () => {
    renderPanel({ mockBlocked: true });
    expect(screen.getByText("sso_credentials.cli.mock_blocked_body")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "sso_credentials.cli.issue_button" }),
    ).not.toBeInTheDocument();
  });

  it("should issue credentials and display the fields", async () => {
    await showCreds();
    expect(screen.getByText("AKIAEXAMPLE12345")).toBeInTheDocument(); // access key always revealed
    expect(screen.getByText(/sso_credentials\.cli\.ttl_remaining/)).toBeInTheDocument();
    // secret は default mask (revealed=false)。
    expect(screen.queryByText("short")).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("https://api.example.com", "team-key", "job-1");
  });

  it("should call onAuthError on a PortalAuthError", async () => {
    mockGet.mockRejectedValue(new PortalAuthError());
    renderPanel();
    fireEvent.click(issueButton());
    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
    expect(screen.queryByText("sso_credentials.cli.error_header")).not.toBeInTheDocument();
  });

  it("should show a stage-aware message on a PortalAssumeRoleError", async () => {
    mockGet.mockRejectedValue(new PortalAssumeRoleError("competitor", "denied"));
    renderPanel();
    fireEvent.click(issueButton());
    expect(await screen.findByText(/sso_credentials\.cli\.assume_role_failed/)).toBeInTheDocument();
  });

  it("should show a validation message on a PortalValidationError", async () => {
    mockGet.mockRejectedValue(new PortalValidationError("bad_input"));
    renderPanel();
    fireEvent.click(issueButton());
    expect(await screen.findByText(/sso_credentials\.validation_error/)).toBeInTheDocument();
  });

  it("should surface a generic error and allow dismissing it", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    renderPanel();
    fireEvent.click(issueButton());
    expect(await screen.findByText("boom")).toBeInTheDocument();
    const dismiss = document.querySelector<HTMLButtonElement>('button[class*="dismiss-button"]');
    fireEvent.click(dismiss as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText("boom")).not.toBeInTheDocument());
  });

  it("should stringify a non-Error rejection", async () => {
    mockGet.mockRejectedValue("plain failure");
    renderPanel();
    fireEvent.click(issueButton());
    expect(await screen.findByText("plain failure")).toBeInTheDocument();
  });
});

describe("CliCredentialsPanel display interactions", () => {
  it("should toggle secret reveal", async () => {
    await showCreds();
    expect(screen.queryByText("short")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "sso_credentials.cli.reveal_secrets_button" }),
    );
    expect(screen.getByText("short")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "sso_credentials.cli.hide_secrets_button" }),
    );
    expect(screen.queryByText("short")).not.toBeInTheDocument();
  });

  it("should copy the export snippet and an individual field", async () => {
    await showCreds();
    fireEvent.click(screen.getByRole("button", { name: "sso_credentials.cli.copy_export_button" }));
    await waitFor(() =>
      expect(clip).toHaveBeenCalledWith(expect.stringContaining("export AWS_ACCESS_KEY_ID=")),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy sso_credentials.cli.field_access_key_id" }),
    );
    await waitFor(() => expect(clip).toHaveBeenCalledWith("AKIAEXAMPLE12345"));
  });

  it("should warn (and not throw) when the clipboard write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clip.mockRejectedValue(new Error("no clipboard"));
    await showCreds();
    fireEvent.click(screen.getByRole("button", { name: "sso_credentials.cli.copy_export_button" }));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("should reissue credentials", async () => {
    await showCreds();
    expect(mockGet).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "sso_credentials.cli.reissue_button" }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it("should clear credentials and restore the issue button", async () => {
    await showCreds();
    fireEvent.click(screen.getByRole("button", { name: "sso_credentials.cli.clear_button" }));
    expect(issueButton()).toBeInTheDocument();
    expect(screen.queryByText("AKIAEXAMPLE12345")).not.toBeInTheDocument();
  });

  it("should show the expired state for a past expiration", async () => {
    await showCreds({ expiration: "2020-01-01T00:00:00Z" });
    expect(screen.getByText("sso_credentials.cli.expired_note")).toBeInTheDocument();
    expect(screen.getByText("sso_credentials.cli.expired_status")).toBeInTheDocument();
  });

  it("should re-evaluate the countdown every second", async () => {
    vi.useFakeTimers();
    try {
      mockGet.mockResolvedValue(creds());
      render(<CliCredentialsPanel {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /sso_credentials\.cli\.section_header/ }));
      fireEvent.click(issueButton());
      await vi.waitFor(() =>
        expect(screen.getByText("sso_credentials.cli.field_access_key_id")).toBeInTheDocument(),
      );
      // 1 秒進めて useCountdown の setNow 経由再 render を踏む。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText(/sso_credentials\.cli\.ttl_remaining/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
