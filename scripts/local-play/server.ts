import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getReasonPhrase, StatusCodes } from "http-status-codes";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { handleLocalPlayRequest } from "./api";
import {
  type CreateStateOptions,
  createLocalPlayState,
  type LocalPlayDeployment,
  type LocalPlayState,
} from "./api-state";
import { corsHeaders, isAllowedCorsOrigin } from "./cors";
import { proxySimulatorNativeRequest } from "./simulator-native-proxy";
import {
  type LocalPlayStateStore,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "./state-store";
import {
  bridgeTerminalSocket,
  consumeTerminalTicket,
  parseTerminalUpgrade,
  type TerminalSocketLike,
} from "./terminal-transport";

export { corsHeaders } from "./cors";

const MAX_BODY_BYTES = 1_000_000;
const CONSOLE_TICKET_PATH = /^\/portal\/me\/problems\/[^/]+\/console$/;

class LocalPlayRequestError extends Error {
  constructor(readonly code: "payload_too_large" | "invalid_json") {
    super(code);
    this.name = "LocalPlayRequestError";
  }
}

export interface LocalPlayServer {
  readonly port: number;
  readonly state: LocalPlayState;
  readonly persist: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly closeStateStore: () => Promise<void>;
}

export interface StartLocalPlayServerOptions extends CreateStateOptions {
  readonly stateStore?: LocalPlayStateStore;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new LocalPlayRequestError("payload_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new LocalPlayRequestError("invalid_json");
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string>,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...cors,
    ...headers,
    ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
  persist: () => Promise<void>,
): Promise<void> {
  const origin = request.headers.origin;
  const cors = corsHeaders(origin);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (rejectForbiddenRequest(request, response, state, url, origin)) return;
  if (await proxySimulatorNativeRequest(request, response, state)) return;
  if (request.method === "OPTIONS") {
    writeJson(response, StatusCodes.NO_CONTENT, undefined, cors);
    return;
  }
  const isConsoleTicketNavigation =
    request.method === "GET" &&
    CONSOLE_TICKET_PATH.test(url.pathname) &&
    url.searchParams.has("ticket");
  if (
    url.pathname.startsWith("/portal/") &&
    !isConsoleTicketNavigation &&
    request.headers.authorization !== `Bearer ${state.participantToken}`
  ) {
    writeJson(response, StatusCodes.UNAUTHORIZED, { error: "unauthorized" }, cors);
    return;
  }
  const query = Object.fromEntries(url.searchParams);
  const body = await readJsonBody(request);
  const result = await handleLocalPlayRequest(
    {
      method: request.method ?? "GET",
      path: url.pathname,
      query,
      body,
      authorization: request.headers.authorization,
    },
    state,
  );
  if (request.method !== "GET" && request.method !== "OPTIONS") await persist();
  writeJson(response, result.status, result.body, cors, result.headers);
}

function rejectForbiddenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
  url: URL,
  origin: string | undefined,
): boolean {
  if (origin !== undefined && !isAllowedCorsOrigin(origin)) {
    writeJson(response, StatusCodes.FORBIDDEN, { error: "browser_origin_forbidden" }, {});
    return true;
  }
  if (!url.pathname.startsWith("/local/operator/")) return false;
  if (origin !== undefined) {
    writeJson(response, StatusCodes.FORBIDDEN, { error: "operator_browser_forbidden" }, {});
    return true;
  }
  if (request.headers.authorization !== `Bearer ${state.participantToken}`) {
    writeJson(response, StatusCodes.UNAUTHORIZED, { error: "unauthorized" }, {});
    return true;
  }
  return false;
}

function classifyLocalPlayRouteError(error: unknown): {
  readonly status: number;
  readonly error: string;
} {
  if (!(error instanceof LocalPlayRequestError)) {
    return { status: StatusCodes.INTERNAL_SERVER_ERROR, error: "internal" };
  }
  return error.code === "payload_too_large"
    ? { status: StatusCodes.REQUEST_TOO_LONG, error: "payload_too_large" }
    : { status: StatusCodes.BAD_REQUEST, error: "invalid_json" };
}

function handleRouteError(
  error: unknown,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const publicError = classifyLocalPlayRouteError(error);
  if (!response.headersSent) {
    writeJson(
      response,
      publicError.status,
      { error: publicError.error },
      corsHeaders(request.headers.origin),
    );
  } else response.end();
}

/**
 * [#2846] Refuse a WebSocket upgrade. There is no `ServerResponse` at this point in the
 * handshake, so the status line goes onto the raw socket by hand before it is dropped.
 */
function rejectUpgrade(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${getReasonPhrase(status)}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * `ws` types a frame as `Buffer | ArrayBuffer | Buffer[]`. With the default `binaryType`
 * ("nodebuffer") this server only ever receives a `Buffer`, but the other two members would
 * stringify through `Object.prototype.toString` ("[object ArrayBuffer]") if that ever changed,
 * so the decode is explicit for all three (@typescript-eslint/no-base-to-string).
 */
function terminalFrameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

/**
 * [#2846] An upgraded socket keeps `server.close` from calling back, so the terminals are
 * reclaimed first: kill the shells, drop the sockets, then the listener. Both teardown calls
 * are needed, for different runtimes — `terminate()` is what reclaims the socket under Node
 * (which detaches an upgraded connection and no longer tracks it), and `closeAllConnections()`
 * is what reclaims it under Bun 1.3.11, where the upgraded connection stays on the server's
 * list and `terminate()` alone leaves `close` hanging forever. Local play `serve` runs on Bun
 * and would never finish Ctrl-C.
 */
function closeServerAndTerminals(
  server: Server,
  wss: WebSocketServer,
  terminalSockets: Set<WebSocket>,
  state: LocalPlayState,
): Promise<void> {
  return new Promise((done) => {
    state.terminals.closeAll();
    for (const accepted of terminalSockets) accepted.terminate();
    terminalSockets.clear();
    wss.close();
    server.closeAllConnections();
    server.close(() => done());
  });
}

function terminalSocketFor(socket: WebSocket): TerminalSocketLike {
  return {
    send: (payload) => socket.send(payload),
    close: () => socket.close(),
    onMessage: (handler) => {
      // A binary frame decodes into something that cannot parse as an input frame,
      // which the bridge already treats as a protocol violation and closes on.
      socket.on("message", (raw) => handler(terminalFrameText(raw)));
    },
    onClose: (handler) => {
      socket.on("close", () => handler());
    },
  };
}

/**
 * [#2846] GET /portal/me/problems/:id/terminal?ticket=... — the only upgrade this server
 * accepts. Origin and ticket are both checked before `handleUpgrade`, so a rejected
 * request never becomes a WebSocket.
 */
function handleTerminalUpgrade(
  context: {
    readonly wss: WebSocketServer;
    readonly sockets: Set<WebSocket>;
    readonly state: LocalPlayState;
  },
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  // A WebSocket handshake is not subject to CORS, so the origin guard is applied by
  // hand here. A non-browser client (CLI, test) sends no Origin at all and is judged
  // on its ticket alone — the same rule the HTTP routes use.
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedCorsOrigin(origin)) {
    rejectUpgrade(socket, StatusCodes.FORBIDDEN);
    return;
  }
  const upgrade = parseTerminalUpgrade(new URL(request.url ?? "/", "http://127.0.0.1"));
  if (!upgrade) {
    rejectUpgrade(socket, StatusCodes.NOT_FOUND);
    return;
  }
  if (!consumeTerminalTicket(context.state, upgrade, Date.now())) {
    rejectUpgrade(socket, StatusCodes.UNAUTHORIZED);
    return;
  }
  context.wss.handleUpgrade(request, socket, head, (accepted) => {
    context.sockets.add(accepted);
    accepted.on("close", () => context.sockets.delete(accepted));
    bridgeTerminalSocket(terminalSocketFor(accepted), context.state, upgrade.problemId);
  });
}

export async function startLocalPlayServer(
  port: number,
  deployment: LocalPlayDeployment,
  options: StartLocalPlayServerOptions = {},
): Promise<LocalPlayServer> {
  const state = createLocalPlayState(deployment, options);
  const stateStore = options.stateStore;
  let saveQueue = Promise.resolve();
  const persist = (): Promise<void> => {
    if (!stateStore) return Promise.resolve();
    const snapshot = snapshotLocalPlayState(state);
    saveQueue = saveQueue
      .catch(() => {
        // Only the ordering matters here: a failed earlier save must not cancel this one,
        // and its rejection was already surfaced to whoever awaited that call.
      })
      .then(() => stateStore.save(snapshot));
    return saveQueue;
  };
  let stateStoreClosed = false;
  const closeStateStore = async (): Promise<void> => {
    if (!stateStore || stateStoreClosed) return;
    stateStoreClosed = true;
    try {
      await persist();
    } finally {
      await stateStore.close();
    }
  };
  try {
    const snapshot = await stateStore?.load();
    if (snapshot) restoreLocalPlayState(state, snapshot);
  } catch (error) {
    await stateStore?.close();
    throw error;
  }
  const server: Server = createServer((request, response) => {
    void route(request, response, state, persist).catch((error) => {
      handleRouteError(error, request, response);
    });
  });
  // [#2846] `noServer` mode: local play already owns exactly one listener, and routing
  // the upgrade by hand is what lets ticket + origin be checked before a socket exists.
  const terminalSockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    handleTerminalUpgrade({ wss, sockets: terminalSockets, state }, request, socket, head);
  });
  return new Promise((resolve, reject) => {
    const rejectStartup = (error: Error): void => {
      void closeStateStore().finally(() => reject(error));
    };
    server.once("error", rejectStartup);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectStartup);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        state,
        persist,
        close: () => closeServerAndTerminals(server, wss, terminalSockets, state),
        closeStateStore,
      });
    });
  });
}
