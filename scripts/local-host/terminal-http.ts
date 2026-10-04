import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type HostTerminals, TERMINAL_MAX_FRAME_BYTES, type TerminalSocket } from "./host-terminal";
import { HostError } from "./model";

function refuse(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${String(status)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function frameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function terminalSocket(socket: WebSocket): TerminalSocket {
  return {
    send: (payload) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > TERMINAL_MAX_FRAME_BYTES) {
        socket.terminate();
        return;
      }
      socket.send(payload);
    },
    close: () => {
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 1000);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    },
    onMessage: (handler) =>
      socket.on("message", (raw, binary) => handler(binary ? "" : frameText(raw))),
    onClose: (handler) => {
      socket.once("close", handler);
      socket.once("error", handler);
    },
  };
}

function upgradeRequest(
  request: IncomingMessage,
  origin: string,
): { problemId: string; ticket: string } {
  const expected = new URL(origin);
  if (
    request.method !== "GET" ||
    request.headers.host !== expected.host ||
    request.headers.origin !== expected.origin
  )
    throw new HostError(403, "Invalid terminal origin.");
  const url = new URL(request.url ?? "/", expected.origin);
  const match = /^\/api\/portal\/me\/problems\/([a-z0-9][a-z0-9-]{0,127})\/terminal$/u.exec(
    url.pathname,
  );
  if (url.origin !== expected.origin || !match)
    throw new HostError(404, "Unknown terminal endpoint.");
  const tickets = url.searchParams.getAll("ticket");
  if (
    tickets.length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "ticket") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(tickets[0] ?? "")
  )
    throw new HostError(401, "Invalid terminal ticket.");
  return { problemId: match[1] ?? "", ticket: tickets[0] ?? "" };
}

/** Install only on the participant listener. Exact Origin, Host and one-use ticket are mandatory. */
export function installTerminalTransport(
  server: Server,
  terminals: HostTerminals,
  origin: () => string,
): { close(): void } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let hadUpgrade = false;
  let closing = false;
  server.on("upgrade", (request, socket, head) => {
    try {
      if (closing) throw new HostError(503, "Terminal listener is closing.");
      const upgrade = upgradeRequest(request, origin());
      if (wss.clients.size >= 256) throw new HostError(429, "Too many terminal sockets.");
      const grant = terminals.redeem(upgrade.problemId, upgrade.ticket);
      wss.handleUpgrade(request, socket, head, (accepted) => {
        hadUpgrade = true;
        void terminals.attach(grant, terminalSocket(accepted)).catch(() => accepted.terminate());
      });
    } catch (error) {
      refuse(socket, error instanceof HostError ? error.status : 500);
    }
  });
  return {
    close: () => {
      if (closing) return;
      closing = true;
      terminals.closeAll();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      // Bun 1.3.11 retains upgraded sockets in the HTTP listener's connection list.
      // Called only during listener shutdown, before service drain/flush.
      if (hadUpgrade) server.closeAllConnections();
    },
  };
}
