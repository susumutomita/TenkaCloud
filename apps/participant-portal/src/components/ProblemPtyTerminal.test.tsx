import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemPtyTerminal } from "./ProblemPtyTerminal";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  inputDispose: vi.fn(),
  disconnect: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  changed: undefined as (() => void) | undefined,
  dimensions: undefined as { cols: number; rows: number } | undefined,
  fail: false,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    constructor() {
      if (mocks.fail) throw new Error("Synthetic renderer failure");
    }
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = mocks.write;
    dispose = mocks.dispose;
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      mocks.resize(cols, rows);
    }
    onData(callback: (data: string) => void) {
      mocks.input = callback;
      return { dispose: mocks.inputDispose };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return mocks.dimensions;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.write.mockReset();
  mocks.dimensions = { cols: 100, rows: 30 };
  mocks.fail = false;
  mocks.input = undefined;
  mocks.changed = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        mocks.changed = callback;
      }
      observe = vi.fn();
      disconnect = mocks.disconnect;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("interactive terminal", () => {
  it("preserves early output, sends raw keys and bounded dimensions, and disposes on disconnect", async () => {
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    const output = {
      pending: "early output",
      write: undefined as ((data: string) => void) | undefined,
    };
    const onFailure = vi.fn();
    const { unmount } = render(
      <ProblemPtyTerminal socket={socket} output={output} label="Terminal" onFailure={onFailure} />,
    );
    expect(screen.getByRole("region", { name: "Terminal" })).toBeInTheDocument();
    await waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ),
    );
    expect(mocks.write).toHaveBeenCalledWith("early output", expect.any(Function));
    expect(output.pending).toBe("");
    act(() => {
      output.write?.("日本語");
      mocks.input?.("\u0003");
    });
    expect(mocks.write).toHaveBeenCalledWith("日本語", expect.any(Function));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "\u0003" }));
    mocks.dimensions = { cols: 500, rows: 300 };
    act(() => mocks.changed?.());
    expect(mocks.resize).toHaveBeenLastCalledWith(256, 128);
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "resize", cols: 256, rows: 128 }),
    );
    unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.inputDispose).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(output.write).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });
  it("does not send to a closed socket and reports renderer initialization failure", async () => {
    const socket = { readyState: 3, send: vi.fn() } as unknown as WebSocket;
    const onFailure = vi.fn();
    const { unmount } = render(
      <ProblemPtyTerminal
        socket={socket}
        output={{ pending: "" }}
        label="Terminal"
        onFailure={onFailure}
      />,
    );
    await waitFor(() => expect(mocks.input).toBeTypeOf("function"));
    act(() => mocks.input?.("ignored"));
    expect(socket.send).not.toHaveBeenCalled();
    unmount();
    mocks.fail = true;
    render(
      <ProblemPtyTerminal
        socket={socket}
        output={{ pending: "" }}
        label="Terminal"
        onFailure={onFailure}
      />,
    );
    await waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
  });
  it("bounds unrendered output and pending WebSocket input", async () => {
    const socket = {
      readyState: 1,
      bufferedAmount: 1024 * 1024,
      send: vi.fn(),
    } as unknown as WebSocket;
    const output = { pending: "", write: undefined as ((data: string) => void) | undefined };
    const onFailure = vi.fn();
    render(
      <ProblemPtyTerminal socket={socket} output={output} label="Terminal" onFailure={onFailure} />,
    );
    await waitFor(() => expect(output.write).toBeTypeOf("function"));
    act(() => {
      output.write?.("x".repeat(4 * 1024 * 1024));
      output.write?.("overflow");
    });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledTimes(2);
    act(() => mocks.input?.("overflow"));
    expect(onFailure).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "input", data: "overflow" }),
    );
  });
});

it("drains parsed output so a healthy renderer can receive another bounded batch", async () => {
  const parsed: (() => void)[] = [];
  mocks.write.mockImplementation((_data: string, callback: () => void) => parsed.push(callback));
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
  const output = { pending: "", write: undefined as ((data: string) => void) | undefined };
  const onFailure = vi.fn();
  render(
    <ProblemPtyTerminal socket={socket} output={output} label="Terminal" onFailure={onFailure} />,
  );
  await waitFor(() => expect(output.write).toBeTypeOf("function"));
  act(() => {
    output.write?.("x".repeat(4 * 1024 * 1024));
    for (const callback of parsed.splice(0)) callback();
    output.write?.("y".repeat(4 * 1024 * 1024));
    mocks.input?.("hello\r");
  });
  expect(onFailure).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "hello\r" }));
});

it("disconnects once when pending WebSocket input exceeds its bound", async () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 1024 * 1024,
    send: vi.fn(),
  } as unknown as WebSocket;
  const onFailure = vi.fn();
  render(
    <ProblemPtyTerminal
      socket={socket}
      output={{ pending: "" }}
      label="Terminal"
      onFailure={onFailure}
    />,
  );
  await waitFor(() => expect(mocks.input).toBeTypeOf("function"));
  act(() => {
    mocks.input?.("overflow");
    mocks.input?.("again");
  });
  expect(onFailure).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "overflow" }));
});

it("cancels initialization when disconnected before imports settle", async () => {
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const onFailure = vi.fn();
  const { unmount } = render(
    <ProblemPtyTerminal
      socket={socket}
      output={{ pending: "early" }}
      label="Terminal"
      onFailure={onFailure}
    />,
  );
  unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(socket.send).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});

it("uses window resize without observers and clamps minimum dimensions", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  mocks.dimensions = undefined;
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
  render(
    <ProblemPtyTerminal
      socket={socket}
      output={{ pending: "" }}
      label="Terminal"
      onFailure={vi.fn()}
    />,
  );
  await waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
  );
  act(() => window.dispatchEvent(new Event("resize")));
  expect(socket.send).toHaveBeenCalledOnce();
  mocks.dimensions = { cols: 0, rows: 0 };
  act(() => window.dispatchEvent(new Event("resize")));
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "resize", cols: 2, rows: 1 }),
  );
});
