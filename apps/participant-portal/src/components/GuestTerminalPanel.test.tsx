import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalNetworkError,
  PortalValidationError,
} from "../api/portal-client";

/**
 * GuestTerminalPanel: issues a one-use Simulator terminal code and shows it with the terminal
 * page link. getGuestTerminal is mocked; the response validation is tested separately below.
 */
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock("../i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n")>();
  return {
    ...actual,
    useT: vi.fn(
      () => (key: string, params?: Readonly<Record<string, string | number>>) =>
        params ? `${key}|${JSON.stringify(params)}` : key,
    ),
  };
});
vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, getGuestTerminal: mockGet };
});

const { GuestTerminalPanel } = await import("./GuestTerminalPanel");

const props = {
  apiBaseUrl: "https://api.example.com",
  sessionToken: "team-key",
  jobId: "job-1",
  onAuthError: vi.fn(),
};

afterEach(() => {
  mockGet.mockReset();
  props.onAuthError.mockReset();
});

describe("GuestTerminalPanel", () => {
  it("issues a code and links only to the Simulator terminal page", async () => {
    mockGet.mockResolvedValue({
      code: "c".repeat(64),
      terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
      expiresAt: "2999-01-01T00:00:00Z",
    });
    render(<GuestTerminalPanel {...props} />);
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    await waitFor(() => expect(screen.getByText("c".repeat(64))).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith("https://api.example.com", "team-key", "job-1");
    const link = screen.getByText("sso_credentials.terminal.open_button").closest("a");
    expect(link?.getAttribute("href")).toBe("http://127.0.0.1:4566/_simulator/terminal");
    expect(link?.getAttribute("rel")).toContain("noopener");
    // The code is never placed in the link.
    expect(link?.getAttribute("href")).not.toContain("c".repeat(64));
    expect(screen.getByText("sso_credentials.terminal.reissue_button")).toBeTruthy();
  });

  it("shows the host's refusal, such as a server that is still starting", async () => {
    mockGet.mockRejectedValue(new PortalNetworkError(409, '{"error":"guest_not_ready"}'));
    render(<GuestTerminalPanel {...props} />);
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    await waitFor(() => expect(screen.getByText("sso_credentials.error_not_ready")).toBeTruthy());
    expect(screen.queryByText(/guest_not_ready|Portal API/)).toBeNull();
    expect(screen.getByText("sso_credentials.terminal.error_header")).toBeTruthy();
  });

  it("explains a viewer-role failure and a host validation refusal, and dismisses them", async () => {
    mockGet.mockRejectedValueOnce(new PortalAssumeRoleError("competitor", "AccessDenied"));
    render(<GuestTerminalPanel {...props} />);
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    expect(await screen.findByText(/sso_credentials\.cli\.assume_role_failed/)).toBeTruthy();
    mockGet.mockRejectedValueOnce(new PortalValidationError("guest_not_ready"));
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    expect(await screen.findByText("sso_credentials.error_not_ready")).toBeTruthy();
    const dismiss = document.querySelector<HTMLButtonElement>('button[class*="dismiss-button"]');
    fireEvent.click(dismiss as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.queryByText("sso_credentials.terminal.error_header")).toBeNull(),
    );
  });

  it("copies the code when the clipboard is available and does nothing otherwise", async () => {
    mockGet.mockResolvedValue({
      code: "d".repeat(64),
      terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
      expiresAt: "2999-01-01T00:00:00Z",
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<GuestTerminalPanel {...props} />);
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    fireEvent.click(await screen.findByText("sso_credentials.terminal.copy_button"));
    expect(writeText).toHaveBeenCalledWith("d".repeat(64));
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    fireEvent.click(screen.getByText("sso_credentials.terminal.copy_button"));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("signs out on an expired session and issues nothing in mock mode", async () => {
    mockGet.mockRejectedValue(new PortalAuthError());
    const { unmount } = render(<GuestTerminalPanel {...props} />);
    fireEvent.click(screen.getByText("sso_credentials.terminal.issue_button"));
    await waitFor(() => expect(props.onAuthError).toHaveBeenCalled());
    unmount();
    render(<GuestTerminalPanel {...props} mockBlocked />);
    expect(screen.queryByText("sso_credentials.terminal.issue_button")).toBeNull();
    expect(screen.getByText("sso_credentials.terminal.mock_blocked")).toBeTruthy();
  });
});

describe("getGuestTerminal", () => {
  it("accepts only a numeric-loopback Simulator terminal page and a 64-character code", async () => {
    const { getGuestTerminal } =
      await vi.importActual<typeof import("../api/portal-client")>("../api/portal-client");
    const respond = (body: unknown) =>
      vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    respond({
      code: "a".repeat(64),
      terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
      expiresAt: "2999-01-01T00:00:00Z",
    });
    await expect(getGuestTerminal("https://api.example.com", "k", "job-1")).resolves.toMatchObject({
      code: "a".repeat(64),
    });
    for (const terminalUrl of [
      "https://evil.example/_simulator/terminal",
      "http://127.0.0.1:4566/_simulator/login",
      "http://127.0.0.1:4566/_simulator/terminal?code=x",
    ]) {
      respond({ code: "a".repeat(64), terminalUrl, expiresAt: "2999-01-01T00:00:00Z" });
      await expect(getGuestTerminal("https://api.example.com", "k", "job-1")).rejects.toThrow();
    }
    respond({
      code: "short",
      terminalUrl: "http://127.0.0.1:4566/_simulator/terminal",
      expiresAt: "2999-01-01T00:00:00Z",
    });
    await expect(getGuestTerminal("https://api.example.com", "k", "job-1")).rejects.toThrow();
    vi.restoreAllMocks();
  });
});
