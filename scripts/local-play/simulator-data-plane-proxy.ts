import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { StatusCodes } from "http-status-codes";
import { codespacesForwardedOrigin } from "./codespaces-origin";
import { parseLoopbackUrl } from "./loopback";
import type { SimulatorDataPlaneRoute } from "./simulator-runtime";

const MAX_DATA_PLANE_BODY_BYTES = 64 * 1024;
const MAX_DATA_PLANE_HEADERS = 64;
const MAX_DATA_PLANE_HEADER_BYTES = 8_192;
const DATA_PLANE_UPSTREAM_TIMEOUT_MS = 10_000;
const DATA_PLANE_REQUEST_TIMEOUT_MS = 10_000;
const DATA_PLANE_HEADERS_TIMEOUT_MS = 5_000;
const DATA_PLANE_CLOSE_GRACE_MS = 1_000;
const NO_WORKERS_CSP = "worker-src 'none'";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PRIVATE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-tenkacloud-deployment-id",
  "x-tenkacloud-simulator-protocol",
  "x-tenkacloud-target-id",
  "x-tenkacloud-world-id",
]);
const PRIVATE_RESPONSE_HEADERS = new Set([
  "authentication-info",
  "authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "service-worker-allowed",
]);
const REJECTED_CLIENT_HOP_HEADERS = new Set([
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);
const DATA_PLANE_METHODS = new Set(["GET", "HEAD", "POST", "QUERY"]);
const DATA_PLANE_ALLOW_METHODS = "GET, HEAD, POST, QUERY, OPTIONS";

function writeProxyError(
  response: ServerResponse,
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error }));
}

function exactOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== origin
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function browserOriginAllowed(origin: string | undefined, apiPort: number | undefined): boolean {
  if (origin === undefined) return true;
  if (!apiPort) return false;
  const url = exactOrigin(origin);
  if (!url) return false;
  if (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port === String(apiPort)
  ) {
    return true;
  }
  return url.protocol === "https:" && url.origin === codespacesForwardedOrigin(apiPort);
}

function dataPlaneCorsHeaders(
  origin: string | undefined,
  apiPort: number | undefined,
): Record<string, string> {
  if (origin === undefined || !browserOriginAllowed(origin, apiPort)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": DATA_PLANE_ALLOW_METHODS,
  };
}

function dataPlaneMethodAllowed(method: string): boolean {
  return method === "OPTIONS" || DATA_PLANE_METHODS.has(method);
}

function upstreamUrl(
  route: SimulatorDataPlaneRoute,
  tail: string,
  search: string,
): URL | undefined {
  const base = parseLoopbackUrl(route.upstreamBaseUrl, "Simulator data-plane upstream");
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    return undefined;
  }
  const path = `/v1/worlds/${encodeURIComponent(route.worldId)}/data-plane/${encodeURIComponent(route.provider)}/${encodeURIComponent(route.targetId)}${tail}${search}`;
  const upstream = new URL(path, base);
  return upstream.origin === base.origin ? upstream : undefined;
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_DATA_PLANE_BODY_BYTES) throw new Error("data_plane_payload_too_large");
    chunks.push(bytes);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function responseBody(upstream: Response): Promise<Uint8Array> {
  const reader = upstream.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_DATA_PLANE_BODY_BYTES) {
      await reader.cancel();
      throw new Error("data_plane_response_too_large");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function forwardedHeaderName(key: string): boolean {
  if (REJECTED_CLIENT_HOP_HEADERS.has(key)) {
    throw new Error("data_plane_hop_header_forbidden");
  }
  return !HOP_BY_HOP_HEADERS.has(key) && !privateForwardingHeader(key);
}

function privateForwardingHeader(name: string): boolean {
  return (
    PRIVATE_REQUEST_HEADERS.has(name) ||
    name === "forwarded" ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("x-github-") ||
    name.startsWith("x-original-") ||
    name.startsWith("cf-")
  );
}

function appendHeader(headers: Headers, key: string, value: string | readonly string[]): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (item.length > MAX_DATA_PLANE_HEADER_BYTES || item.includes("\r") || item.includes("\n")) {
      throw new Error("data_plane_header_invalid");
    }
    headers.append(key, item);
  }
}

function upstreamHeaders(request: IncomingMessage, launchToken: string): Headers {
  const headers = new Headers();
  let count = 0;
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || !forwardedHeaderName(key)) continue;
    count += 1;
    if (count > MAX_DATA_PLANE_HEADERS) throw new Error("data_plane_headers_too_large");
    appendHeader(headers, key, value);
  }
  headers.set("authorization", `Bearer ${launchToken}`);
  return headers;
}

function assertResponseHeadersValid(entries: readonly (readonly [string, string])[]): void {
  if (entries.length > MAX_DATA_PLANE_HEADERS) {
    throw new Error("data_plane_response_headers_invalid");
  }
  const invalid = entries.some(
    ([key, value]) =>
      key.length > MAX_DATA_PLANE_HEADER_BYTES ||
      value.length > MAX_DATA_PLANE_HEADER_BYTES ||
      value.includes("\r") ||
      value.includes("\n"),
  );
  if (invalid) throw new Error("data_plane_response_headers_invalid");
}

function responseHeaderAllowed(key: string): boolean {
  return (
    !HOP_BY_HOP_HEADERS.has(key) &&
    !PRIVATE_RESPONSE_HEADERS.has(key) &&
    key !== "content-encoding" &&
    key !== "content-length" &&
    key !== "vary" &&
    key !== "timing-allow-origin" &&
    !key.startsWith("access-control-")
  );
}

/** Normalise `getHeader()`'s three shapes (absent / single / list) into a list. */
function existingHeaderValues(existing: number | string | string[] | undefined): string[] {
  if (Array.isArray(existing)) return existing.map(String);
  return existing === undefined ? [] : [String(existing)];
}

function setForwardedResponseHeader(response: ServerResponse, key: string, value: string): void {
  if (key !== "content-security-policy") {
    response.setHeader(key, value);
    return;
  }
  const policies = existingHeaderValues(response.getHeader(key));
  response.setHeader(key, [value, ...policies]);
}

function copyResponseHeaders(
  upstream: Response,
  response: ServerResponse,
  origin: string | undefined,
  apiPort: number | undefined,
): void {
  const entries = [...upstream.headers];
  assertResponseHeadersValid(entries);
  for (const [key, value] of entries) {
    if (responseHeaderAllowed(key)) setForwardedResponseHeader(response, key, value);
  }
  for (const [key, value] of Object.entries(dataPlaneCorsHeaders(origin, apiPort))) {
    response.setHeader(key, value);
  }
}

function requestHeadersAllowed(request: IncomingMessage): boolean {
  if (request.rawHeaders.length / 2 > MAX_DATA_PLANE_HEADERS) return false;
  return request.rawHeaders.every(
    (value) =>
      value.length <= MAX_DATA_PLANE_HEADER_BYTES && !value.includes("\r") && !value.includes("\n"),
  );
}

function requestErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) return StatusCodes.BAD_GATEWAY;
  if (error.message === "data_plane_payload_too_large") return StatusCodes.REQUEST_TOO_LONG;
  if (
    error.message === "data_plane_hop_header_forbidden" ||
    error.message === "data_plane_headers_too_large" ||
    error.message === "data_plane_header_invalid" ||
    error.message === "data_plane_method_invalid" ||
    error.message === "data_plane_method_body_forbidden"
  ) {
    return StatusCodes.BAD_REQUEST;
  }
  return StatusCodes.BAD_GATEWAY;
}

async function fetchDataPlaneResponse(
  request: IncomingMessage,
  route: SimulatorDataPlaneRoute,
  targetUrl: URL,
  method: string,
  fetchFn: typeof fetch,
  closeSignal?: AbortSignal,
): Promise<readonly [Response, Uint8Array]> {
  const headers = upstreamHeaders(request, route.launchToken);
  const body = await requestBody(request);
  if ((method === "GET" || method === "HEAD") && body) {
    throw new Error("data_plane_method_body_forbidden");
  }
  if (closeSignal?.aborted) throw new Error("data_plane_listener_closing");
  const timeoutSignal = AbortSignal.timeout(DATA_PLANE_UPSTREAM_TIMEOUT_MS);
  const upstream = await fetchFn(targetUrl, {
    method,
    headers,
    redirect: "manual",
    signal: closeSignal ? AbortSignal.any([timeoutSignal, closeSignal]) : timeoutSignal,
    ...(body ? { body } : {}),
  });
  return [upstream, await responseBody(upstream)];
}

function writeDataPlaneRequestError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  apiPort: number | undefined,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = requestErrorStatus(error);
  const message =
    status === StatusCodes.BAD_GATEWAY || !(error instanceof Error)
      ? "data_plane_proxy_failed"
      : error.message;
  writeProxyError(response, status, message, dataPlaneCorsHeaders(origin, apiPort));
}

async function forwardDataPlaneRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: SimulatorDataPlaneRoute,
  targetUrl: URL,
  method: string,
  origin: string | undefined,
  apiPort: number | undefined,
  fetchFn: typeof fetch,
  closeSignal?: AbortSignal,
): Promise<void> {
  try {
    const [upstream, rawResponseBody] = await fetchDataPlaneResponse(
      request,
      route,
      targetUrl,
      method,
      fetchFn,
      closeSignal,
    );
    copyResponseHeaders(upstream, response, origin, apiPort);
    response.statusCode = upstream.status;
    response.end(method === "HEAD" ? undefined : rawResponseBody);
  } catch (error) {
    writeDataPlaneRequestError(response, error, origin, apiPort);
  }
}

export interface SimulatorDataPlaneListener {
  readonly port: number;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function resolveRouteWhileOpen(
  resolveRoute: () => Promise<SimulatorDataPlaneRoute>,
  closeSignal: AbortSignal,
): Promise<SimulatorDataPlaneRoute> {
  if (closeSignal.aborted) return Promise.reject(new Error("data_plane_listener_closing"));
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new Error("data_plane_listener_closing"));
    closeSignal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve()
      .then(resolveRoute)
      .then(resolve, reject)
      .finally(() => closeSignal.removeEventListener("abort", aborted));
  });
}

function fixedListenerHostAllowed(host: string | undefined, port: number | undefined): boolean {
  if (!host || !port) return false;
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  const codespacesOrigin = codespacesForwardedOrigin(port);
  return codespacesOrigin !== undefined && host === new URL(codespacesOrigin).host;
}

interface FixedDataPlaneRequest {
  readonly origin: string | undefined;
  readonly listenerPort: number | undefined;
  readonly method: string;
  readonly requestUrl: URL;
}

function fixedListenerAccessAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  isClosing: () => boolean,
): boolean {
  const listenerPort = request.socket.localPort;
  if (!requestHeadersAllowed(request)) {
    writeProxyError(
      response,
      StatusCodes.REQUEST_HEADER_FIELDS_TOO_LARGE,
      "data_plane_headers_too_large",
    );
    return false;
  }
  if (!fixedListenerHostAllowed(request.headers.host, listenerPort)) {
    writeProxyError(response, StatusCodes.MISDIRECTED_REQUEST, "data_plane_host_forbidden");
    return false;
  }
  if (isClosing()) {
    writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
    return false;
  }
  if (!browserOriginAllowed(request.headers.origin, listenerPort)) {
    writeProxyError(response, StatusCodes.FORBIDDEN, "data_plane_browser_origin_forbidden");
    return false;
  }
  return true;
}

function fixedDataPlaneRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isClosing: () => boolean,
): FixedDataPlaneRequest | undefined {
  if (!fixedListenerAccessAllowed(request, response, isClosing)) return undefined;
  const origin = request.headers.origin;
  const listenerPort = request.socket.localPort;
  const method = request.method ?? "GET";
  if (!dataPlaneMethodAllowed(method)) {
    writeProxyError(
      response,
      StatusCodes.BAD_REQUEST,
      "data_plane_method_invalid",
      dataPlaneCorsHeaders(origin, listenerPort),
    );
    return undefined;
  }
  if (method === "OPTIONS") {
    if (origin === undefined) {
      writeProxyError(response, StatusCodes.BAD_REQUEST, "data_plane_method_invalid");
    } else {
      response.writeHead(StatusCodes.NO_CONTENT, dataPlaneCorsHeaders(origin, listenerPort));
      response.end();
    }
    return undefined;
  }
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!requestUrl.pathname.startsWith("/") || requestUrl.pathname.startsWith("//")) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return undefined;
  }
  return { origin, listenerPort, method, requestUrl };
}

async function resolvedDataPlaneRoute(
  response: ServerResponse,
  resolveRoute: () => Promise<SimulatorDataPlaneRoute>,
  closeSignal: AbortSignal,
  isClosing: () => boolean,
): Promise<SimulatorDataPlaneRoute | undefined> {
  try {
    return await resolveRouteWhileOpen(resolveRoute, closeSignal);
  } catch {
    if (isClosing()) {
      writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
    } else {
      writeProxyError(response, StatusCodes.NOT_FOUND, "unknown_simulator_target");
    }
    return undefined;
  }
}

async function proxyFixedSimulatorTarget(
  request: IncomingMessage,
  response: ServerResponse,
  resolveRoute: () => Promise<SimulatorDataPlaneRoute>,
  fetchFn: typeof fetch,
  closeSignal: AbortSignal,
  isClosing: () => boolean,
): Promise<void> {
  response.setHeader("content-security-policy", NO_WORKERS_CSP);
  const context = fixedDataPlaneRequest(request, response, isClosing);
  if (!context) return;
  const route = await resolvedDataPlaneRoute(response, resolveRoute, closeSignal, isClosing);
  if (!route) return;
  if (isClosing()) {
    writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
    return;
  }
  const targetUrl = upstreamUrl(route, context.requestUrl.pathname, context.requestUrl.search);
  if (!targetUrl) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return;
  }
  await forwardDataPlaneRequest(
    request,
    response,
    route,
    targetUrl,
    context.method,
    context.origin,
    context.listenerPort,
    fetchFn,
    closeSignal,
  );
}

function waitForDataPlaneServerClose(
  server: Server,
  sockets: ReadonlySet<Socket>,
  closeController: AbortController,
): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    const forceClose = setTimeout(() => {
      closeController.abort();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      resolveClose();
    }, DATA_PLANE_CLOSE_GRACE_MS);
    forceClose.unref();
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) rejectClose(error);
      else resolveClose();
    });
    server.closeIdleConnections();
  });
}

async function closeDataPlaneServer(
  server: Server,
  sockets: ReadonlySet<Socket>,
  closeController: AbortController,
  activeHandlers: ReadonlySet<Promise<void>>,
): Promise<void> {
  await waitForDataPlaneServerClose(server, sockets, closeController);
  await Promise.allSettled([...activeHandlers]);
}

/** Start one isolated loopback origin for exactly one problem target. */
/**
 * Make a close function idempotent: repeat calls join the in-flight teardown, and a failed
 * teardown is forgotten so a later caller can retry instead of being handed the same rejection
 * forever.
 */
function onceCloser(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    closing = close().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
}

export function startSimulatorDataPlaneListener(
  resolveRoute: () => Promise<SimulatorDataPlaneRoute>,
  fetchFn: typeof fetch = fetch,
): Promise<SimulatorDataPlaneListener> {
  const sockets = new Set<Socket>();
  const activeHandlers = new Set<Promise<void>>();
  const closeController = new AbortController();
  let closeRequested = false;
  const server: Server = createServer((request, response) => {
    const handler = proxyFixedSimulatorTarget(
      request,
      response,
      resolveRoute,
      fetchFn,
      closeController.signal,
      () => closeRequested,
    ).catch(() => {
      if (!response.headersSent) {
        writeProxyError(response, StatusCodes.BAD_GATEWAY, "data_plane_proxy_failed");
      } else {
        response.end();
      }
    });
    activeHandlers.add(handler);
    void handler.finally(() => activeHandlers.delete(handler));
  });
  server.requestTimeout = DATA_PLANE_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DATA_PLANE_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Simulator data-plane listener did not bind to loopback"));
        return;
      }
      const port = address.port;
      accept({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: onceCloser(() => {
          closeRequested = true;
          return closeDataPlaneServer(server, sockets, closeController, activeHandlers);
        }),
      });
    });
  });
}
