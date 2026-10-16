import type { TerminalHandlers, TerminalProcess } from "./terminal-shell";

// Fixed code only: coordinates and numeric identities travel as separate argv values.
export const TERMINAL_WRAPPER = `set -f
IFS= read -r stat < /proc/$$/stat || exit 125
rest="\${stat##*) }"
set -- $rest
printf '\\036TENKACLOUD:%s:%s\\037' "$$" "\${20}"
exec /bin/sh`;
export const TERMINAL_CLEANUP = `set -f
pid="$1"; expected="$2"
case "$pid:$expected" in *[!0-9:]*|:*|*:) exit 125;; esac
[ "$pid" -gt 1 ] || exit 125
[ -r "/proc/$pid/stat" ] || exit 0
IFS= read -r stat < "/proc/$pid/stat" || exit 125
rest="\${stat##*) }"; set -- $rest
[ "\${20}" = "$expected" ] || exit 0
kill -KILL "$pid" || exit 125
n=0
while [ -r "/proc/$pid/stat" ]; do
  IFS= read -r stat < "/proc/$pid/stat" || exit 0
  rest="\${stat##*) }"; set -- $rest
  [ "\${20}" = "$expected" ] || exit 0
  [ "$1" = Z ] && exit 0
  n=$((n+1)); [ "$n" -lt 20 ] || exit 125
  sleep 0.1
done`;

/** Retains ownership until the pinned remote shell's exit is confirmed. */
export function terminalSession(
  start: (handlers: TerminalHandlers) => TerminalProcess,
  cleanup: (pid: string, starttime: string) => Promise<void>,
  handlers: TerminalHandlers,
  assertCurrent: () => void = () => undefined,
): TerminalProcess {
  let identity: { pid: string; starttime: string } | undefined;
  let header = "";
  let ended = false;
  let local: TerminalProcess | undefined;
  let resolveClosed: () => void = () => undefined;
  let rejectClosed: (error: Error) => void = (_error: Error) => undefined;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // A caller can attach its observer after a synchronous transport failure.
  void closed.catch(() => undefined);
  const queued: string[] = [];
  let queuedBytes = 0;
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    queued.length = 0;
    try {
      local?.kill();
    } catch {
      /* Remote cleanup still owns completion. */
    }
    void (async () => {
      if (!identity) throw new Error("Terminal identity was not confirmed; ownership retained.");
      await cleanup(identity.pid, identity.starttime);
      resolveClosed();
      handlers.onExit(code);
    })().catch((error: unknown) => {
      rejectClosed(error instanceof Error ? error : new Error("Terminal cleanup failed."));
      // Notify the browser, while closed remains rejected and its admission slot stays reserved.
      handlers.onExit(null);
    });
  };
  const timer = setTimeout(() => finish(null), 5000);
  const flushQueued = () => {
    try {
      assertCurrent();
      for (const input of queued) {
        assertCurrent();
        local?.write(input);
      }
    } catch {
      finish(null);
    }
  };
  const acceptHeader = (chunk: string) => {
    header += chunk;
    const end = header.indexOf("\x1f");
    if (end < 0) {
      if (header.length > 256) finish(null);
      return;
    }
    const prefix = header.slice(0, end);
    const match = /^TENKACLOUD:(\d{1,10}):(\d{1,20})$/u.exec(prefix.slice(1));
    if (!prefix.startsWith("\x1e") || !match || Number(match[1]) <= 1) {
      finish(null);
      return;
    }
    identity = { pid: match[1] ?? "", starttime: match[2] ?? "" };
    clearTimeout(timer);
    const tail = header.slice(end + 1);
    header = "";
    if (tail) handlers.onData(tail);
    flushQueued();
    queued.length = 0;
    queuedBytes = 0;
  };
  try {
    local = start({
      onData: (chunk) => {
        if (ended) return;
        if (identity) {
          handlers.onData(chunk);
          return;
        }
        acceptHeader(chunk);
      },
      onExit: finish,
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  if (ended) local.kill();
  return {
    closed,
    write: (data) => {
      if (ended) return;
      // Docker detach is fixed to ctrl-@. Never forward that byte, including across frames.
      if (data.includes("\0")) {
        finish(null);
        return;
      }
      if (identity) {
        try {
          assertCurrent();
          local?.write(data);
        } catch {
          finish(null);
        }
      } else {
        queuedBytes += Buffer.byteLength(data);
        if (queuedBytes > 1024 * 1024) finish(null);
        else queued.push(data);
      }
    },
    resize: (cols, rows) => {
      if (!ended) local?.resize?.(cols, rows);
    },
    kill: () => finish(null),
  };
}
