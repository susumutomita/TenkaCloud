import type { LocalPlayState } from "./api-state";
import type { AttachFailure } from "./problem-terminal";

/**
 * [#2846] The wire protocol for the problem terminal, kept apart from the `node:http`
 * server so both directions are unit-testable without a socket.
 *
 * Frames are JSON text, one message per frame:
 *
 *   client → server  `{"type":"input","data":"ls\n"}`
 *   server → client  `{"type":"data","data":"show.py\n"}`
 *                    `{"type":"exit","code":0}` / `{"type":"exit","code":null,"reason":"not_running"}`
 *
 * A frame that does not parse, or carries an unknown `type`, ends the session. Ignoring
 * it would leave the participant typing into a shell that is quietly discarding half of
 * what they send — the terminal has to be either honest or gone.
 */

const TERMINAL_UPGRADE_RE = /^\/portal\/me\/problems\/([^/]+)\/terminal$/;

export interface TerminalUpgradeRequest {
  readonly problemId: string;
  readonly ticket: string;
}

/** Match the terminal upgrade path and pull out its problem id + ticket. */
export function parseTerminalUpgrade(url: URL): TerminalUpgradeRequest | undefined {
  const match = TERMINAL_UPGRADE_RE.exec(url.pathname);
  if (!match) return undefined;
  const ticket = url.searchParams.get("ticket");
  if (!ticket) return undefined;
  let problemId: string;
  try {
    problemId = decodeURIComponent(match[1]);
  } catch {
    // A malformed percent escape is an unknown problem, not a crash.
    return undefined;
  }
  return { problemId, ticket };
}

/**
 * Redeem a terminal handoff ticket. Deletes it whether or not it validates: a ticket is
 * single-use, and a mismatched-but-surviving ticket would let a wrong guess be retried.
 */
export function consumeTerminalTicket(
  state: LocalPlayState,
  request: TerminalUpgradeRequest,
  now: number,
): boolean {
  const handoff = state.terminalHandoffs.get(request.ticket);
  state.terminalHandoffs.delete(request.ticket);
  if (!handoff) return false;
  return handoff.problemId === request.problemId && handoff.expiresAtMs > now;
}

/** The socket capabilities the bridge needs; `server.ts` adapts a real `ws` socket to it. */
export interface TerminalSocketLike {
  readonly send: (payload: string) => void;
  readonly close: () => void;
  readonly onMessage: (handler: (raw: string) => void) => void;
  readonly onClose: (handler: () => void) => void;
}

export function terminalDataFrame(chunk: string): string {
  return JSON.stringify({ type: "data", data: chunk });
}

export function terminalExitFrame(code: number | null, reason?: AttachFailure): string {
  return JSON.stringify({ type: "exit", code, ...(reason ? { reason } : {}) });
}

/** Decode one client frame; `undefined` for anything that is not a well-formed input. */
export function parseTerminalInput(raw: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return undefined;
  const { type, data } = frame as { type?: unknown; data?: unknown };
  if (type !== "input" || typeof data !== "string") return undefined;
  return data;
}

/**
 * Join one accepted WebSocket to a container shell.
 *
 * The attach failure is reported over the established socket rather than by refusing the
 * upgrade: the handshake already succeeded by the time we know the container's state, and
 * `{"type":"exit","reason":"not_running"}` is something the portal can show. A refused
 * upgrade would reach the browser as an opaque connection error.
 */
export function bridgeTerminalSocket(
  socket: TerminalSocketLike,
  state: LocalPlayState,
  problemId: string,
): void {
  let ended = false;
  const end = (code: number | null, reason?: AttachFailure): void => {
    if (ended) return;
    ended = true;
    socket.send(terminalExitFrame(code, reason));
    socket.close();
  };

  const result = state.terminals.attach(problemId, {
    onData: (chunk) => {
      if (!ended) socket.send(terminalDataFrame(chunk));
    },
    // `attach` can deliver an exit before it returns (the container was reaped
    // mid-attach); `end` is idempotent so that arrives once, not twice.
    onExit: (code) => end(code),
  });
  if (!result.ok) {
    end(null, result.reason);
    return;
  }

  const session = result.session;
  socket.onMessage((raw) => {
    const input = parseTerminalInput(raw);
    if (input === undefined) {
      session.close();
      return;
    }
    session.write(input);
  });
  socket.onClose(() => {
    // The peer is gone, so nothing more may be written to it — but the shell it was
    // driving still has to die, or the container keeps a `/bin/sh` nobody is reading.
    ended = true;
    session.close();
  });
}
