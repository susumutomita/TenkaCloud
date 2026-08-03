import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalNetworkError, PortalValidationError } from "../api/portal-client";
import { I18nProvider } from "../i18n";
import { ProblemTerminalPanel } from "./ProblemTerminalPanel";

/**
 * [#2846] container terminal UI の pin。 backend contract (scripts/local-play/, 別 agent 実装中)
 * は固定済み — POST .../terminal-handoff → {ticket, expiresInMs} / 404 unknown_problem /
 * 409 not_running、 WS フレーム {type:"data"|"exit", ...}。 ここでは `issueProblemTerminalHandoff`
 * だけ mock し (= HTTP を叩かない)、 WebSocket は global を差し替えたフェイクで駆動する
 * (xterm.js 等は使わない、 素の pre/input なので DOM 上の役割で拾える)。
 */

const apiMocks = vi.hoisted(() => ({
  issueProblemTerminalHandoff: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return {
    ...actual,
    issueProblemTerminalHandoff: apiMocks.issueProblemTerminalHandoff,
  };
});

/** WebSocket の最小フェイク。 実装は onopen/onmessage/onclose だけを使うのでそれだけ再現する。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function renderPanel() {
  return render(
    <I18nProvider>
      <ProblemTerminalPanel
        apiBaseUrl="https://api.example.com"
        sessionToken="team-key"
        problemId="sha256-1"
      />
    </I18nProvider>,
  );
}

/** Connect click → handoff resolve → socket open → input row visible, in one step. */
async function connectAndOpen(
  user: ReturnType<typeof userEvent.setup>,
  ticket = "tik-1",
): Promise<FakeWebSocket> {
  apiMocks.issueProblemTerminalHandoff.mockResolvedValueOnce(ticket);
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error("unreachable: waitFor guarantees an instance exists");
  act(() => ws.onopen?.());
  await screen.findByRole("textbox");
  return ws;
}

function scrollbackText(container: HTMLElement): string {
  return container.querySelector("pre")?.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  apiMocks.issueProblemTerminalHandoff.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ProblemTerminalPanel (#2846)", () => {
  it("should start idle with only a Connect button (no scrollback, no input)", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector("pre")).not.toBeInTheDocument();
  });

  it("should hand off a ticket, open a socket at the derived wss URL, and show the input row once open", async () => {
    const user = userEvent.setup();
    apiMocks.issueProblemTerminalHandoff.mockResolvedValueOnce("tik-1");
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(apiMocks.issueProblemTerminalHandoff).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "sha256-1",
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe("wss://api.example.com/portal/me/problems/sha256-1/terminal?ticket=tik-1");
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    act(() => ws?.onopen?.());

    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
  });

  it("should render inbound data frames as scrollback", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const ws = await connectAndOpen(user);

    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "data", data: "$ hello\n" }) }));

    expect(scrollbackText(container)).toBe("$ hello\n");
  });

  it("should send a line on Send click, echo it locally, and clear the input", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const ws = await connectAndOpen(user);

    const input = screen.getByRole("textbox");
    await user.type(input, "ls");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(ws.sent).toEqual([JSON.stringify({ type: "input", data: "ls\n" })]);
    expect(scrollbackText(container)).toBe("ls\n");
    expect(input).toHaveValue("");
  });

  it("should send a line on Enter, but not while an IME composition is in progress", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const ws = await connectAndOpen(user);

    const input = screen.getByRole("textbox");
    // isComposing Enter (IME candidate confirmation) must not send.
    fireComposingEnter(input);
    expect(ws.sent).toHaveLength(0);

    await user.type(input, "pwd{Enter}");
    expect(ws.sent).toEqual([JSON.stringify({ type: "input", data: "pwd\n" })]);
    expect(scrollbackText(container)).toBe("pwd\n");
  });

  it("should show the exit code and reason on an exit frame, close the socket, and offer Reconnect", async () => {
    const user = userEvent.setup();
    renderPanel();
    const ws = await connectAndOpen(user);

    act(() =>
      ws.onmessage?.({ data: JSON.stringify({ type: "exit", code: 137, reason: "oom-killed" }) }),
    );

    expect(screen.getByText("The shell exited (code 137)")).toBeInTheDocument();
    expect(screen.getByText("oom-killed")).toBeInTheDocument();
    expect(ws.closeCalls).toBe(1);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("should show a no-code exit message when the exit frame carries neither code nor reason", async () => {
    const user = userEvent.setup();
    renderPanel();
    const ws = await connectAndOpen(user);

    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "exit" }) }));

    expect(screen.getByText("The shell exited")).toBeInTheDocument();
  });

  it("should treat an unsolicited WS close after opening (no prior exit frame) as an exit with no code", async () => {
    const user = userEvent.setup();
    renderPanel();
    const ws = await connectAndOpen(user);

    act(() => ws.onclose?.());

    expect(screen.getByText("The shell exited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("should report a connect failure (not a shell exit) when the socket closes before ever opening", async () => {
    // Handshake rejection, a bad ticket, or an upgrade that never reaches the server
    // (the Codespaces bridge case) all close the socket without an open event first.
    // That must not read as "the shell exited" — the shell never started.
    const user = userEvent.setup();
    apiMocks.issueProblemTerminalHandoff.mockResolvedValueOnce("tik-1");
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0];

    act(() => ws?.onclose?.());

    expect(screen.getByText("Failed to connect. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByText(/The shell exited/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("should re-issue the handoff and open a fresh socket on Reconnect", async () => {
    const user = userEvent.setup();
    renderPanel();
    const first = await connectAndOpen(user, "tik-1");
    act(() => first.onmessage?.({ data: JSON.stringify({ type: "exit", code: 0 }) }));
    await screen.findByRole("button", { name: "Reconnect" });

    apiMocks.issueProblemTerminalHandoff.mockResolvedValueOnce("tik-2");
    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(apiMocks.issueProblemTerminalHandoff).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("ticket=tik-2");
  });

  it("should show the not-running message on a 409 handoff and return to idle without opening a socket", async () => {
    const user = userEvent.setup();
    apiMocks.issueProblemTerminalHandoff.mockRejectedValueOnce(
      new PortalValidationError("not_running"),
    );
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("The container is not running. Start it, then connect."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("should surface a generic handoff failure (e.g. unknown_problem 404) without hiding it", async () => {
    const user = userEvent.setup();
    apiMocks.issueProblemTerminalHandoff.mockRejectedValueOnce(
      new PortalNetworkError(404, '{"error":"unknown_problem"}'),
    );
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/Portal API 404/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("should close the socket and return to idle (not the exited screen) when Disconnect is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();
    const ws = await connectAndOpen(user);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(ws.closeCalls).toBe(1);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByText(/The shell exited/)).not.toBeInTheDocument();
  });

  it("should close the socket on unmount while connected", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    const ws = await connectAndOpen(user);

    unmount();

    expect(ws.closeCalls).toBe(1);
  });

  it("should unmount cleanly without ever connecting", () => {
    const { unmount } = renderPanel();
    expect(() => unmount()).not.toThrow();
  });

  it("should not leak a socket if the component unmounts while the handoff is still in flight", async () => {
    const user = userEvent.setup();
    let resolveHandoff: (ticket: string) => void = () => {};
    apiMocks.issueProblemTerminalHandoff.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveHandoff = resolve;
      }),
    );
    const { unmount } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    unmount();
    await act(async () => {
      resolveHandoff("tik-late");
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("should not surface a handoff failure that arrives after the component unmounted", async () => {
    const user = userEvent.setup();
    let rejectHandoff: (err: unknown) => void = () => {};
    apiMocks.issueProblemTerminalHandoff.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        rejectHandoff = reject;
      }),
    );
    const { unmount } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    unmount();
    // Resolving after unmount must not throw (no state update on an unmounted tree)
    // and must not open a socket either.
    await act(async () => {
      rejectHandoff(new PortalValidationError("not_running"));
      await Promise.resolve().catch(() => undefined);
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("should ignore malformed or unrecognized frames without crashing the connection", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const ws = await connectAndOpen(user);

    act(() => {
      ws.onmessage?.({ data: "not json" });
      ws.onmessage?.({ data: "null" });
      ws.onmessage?.({ data: "42" });
      ws.onmessage?.({ data: JSON.stringify({ type: "ping" }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "data", data: 123 }) });
    });

    // None of the above were valid data/exit frames: still connected, scrollback untouched.
    expect(scrollbackText(container)).toBe("");
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "data", data: "still alive" }) }));
    expect(scrollbackText(container)).toBe("still alive");
  });

  it("should cap scrollback to the most recent lines and drop the oldest", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const ws = await connectAndOpen(user);

    const lines = Array.from({ length: 510 }, (_, i) => `line-${i}`).join("\n");
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: "data", data: lines }) }));

    const text = scrollbackText(container);
    expect(text).not.toContain("line-0\n");
    expect(text.startsWith("line-10")).toBe(true);
    expect(text.endsWith("line-509")).toBe(true);
  });

  it("should still connect when React double-invokes the mount effect (StrictMode)", async () => {
    // Repro: `main.tsx` renders the app inside <StrictMode>, so in dev every effect runs
    // mount → cleanup → mount. The cleanup arms the in-flight-handoff guard, and the
    // throwaway first pass used to leave it armed for the real mount — the handoff then
    // resolved and `connect` bailed on the guard, pinning the panel at "Connecting…"
    // forever. Seen in the running portal; a plain `render()` never double-invokes, so
    // every other test in this file stayed green through it.
    const user = userEvent.setup();
    apiMocks.issueProblemTerminalHandoff.mockResolvedValueOnce("tik-strict");
    render(
      <StrictMode>
        <I18nProvider>
          <ProblemTerminalPanel
            apiBaseUrl="https://api.example.com"
            sessionToken="team-key"
            problemId="sha256-1"
          />
        </I18nProvider>
      </StrictMode>,
    );

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("unreachable: waitFor guarantees an instance exists");
    act(() => ws.onopen?.());

    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
  });
});

/** Dispatch a keydown Enter with isComposing=true directly (userEvent has no IME composition API). */
function fireComposingEnter(input: HTMLElement): void {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", { value: true });
  input.dispatchEvent(event);
}
