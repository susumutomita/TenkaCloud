import type { TerminalHandlers, TerminalProcess } from "./terminal-shell";

const MAX_INPUT_BYTES = 1024 * 1024;
export function terminalPtyAvailable(): boolean {
  return (
    typeof Bun !== "undefined" && typeof Bun.Terminal === "function" && process.platform !== "win32"
  );
}

/** Internal PTY adapter. The caller pins the Compose command, service and /bin/sh. */
export function spawnTerminalPty(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  handlers: TerminalHandlers,
): TerminalProcess {
  const decoder = new TextDecoder();
  const queued: Uint8Array[] = [];
  let pendingBytes = 0;
  let ended = false;
  let flushing = false;
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    queued.length = 0;
    const tail = decoder.decode();
    if (tail) handlers.onData(tail);
    terminal.close();
    handlers.onExit(code);
  };
  const writeNext = () => {
    const next = queued.shift();
    if (!next) return false;
    const written = terminal.write(next);
    pendingBytes -= written;
    if (written < next.byteLength) queued.unshift(next.subarray(written));
    return written > 0;
  };
  const flush = () => {
    if (flushing || ended) return;
    flushing = true;
    try {
      while (queued.length && writeNext()) {
        /* Stop until drain when the PTY is backpressured. */
      }
    } catch {
      child.kill("SIGKILL");
      finish(null);
    } finally {
      flushing = false;
    }
  };
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data: (_terminal, bytes) => {
      if (!ended) {
        const text = decoder.decode(bytes, { stream: true });
        if (text) handlers.onData(text);
      }
    },
    drain: flush,
  });
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([command, ...args], {
      env: { ...env, TERM: "xterm-256color" },
      terminal,
      onExit: (_child, code) => finish(code),
    });
  } catch (error) {
    terminal.close();
    throw error;
  }
  return {
    write: (data) => {
      if (ended) return;
      const bytes = new TextEncoder().encode(data);
      if (pendingBytes + bytes.byteLength > MAX_INPUT_BYTES) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      pendingBytes += bytes.byteLength;
      queued.push(bytes);
      flush();
    },
    resize: (cols, rows) => {
      if (!ended) {
        terminal.resize(cols, rows);
        // Notify the pinned CLI as well; an externally attached PTY may have no foreground group.
        child.kill("SIGWINCH");
      }
    },
    kill: () => {
      if (!ended) {
        child.kill("SIGKILL");
        finish(null);
      }
    },
  };
}
