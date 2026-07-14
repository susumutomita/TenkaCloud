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

function copyResponseHeaders(
  upstream: Response,
  response: ServerResponse,
  origin: string | undefined,
  apiPort: number | undefined,
): void {
  const entries = [...upstream.headers];
  if (
    entries.length > MAX_DATA_PLANE_HEADERS ||
    entries.some(
      ([key, value]) =>
        key.length > MAX_DATA_PLANE_HEADER_BYTES ||
        value.length > MAX_DATA_PLANE_HEADER_BYTES ||
        value.includes("\r") ||
        value.includes("\n"),
    )
  ) {
    throw new Error("data_plane_response_headers_invalid");
  }
  for (const [key, value] of entries) {
    if (
      !HOP_BY_HOP_HEADERS.has(key) &&
      !PRIVATE_RESPONSE_HEADERS.has(key) &&
      key !== "content-encoding" &&
      key !== "content-length" &&
      key !== "vary" &&
      key !== "timing-allow-origin" &&
      !key.startsWith("access-control-")
    ) {
      if (key === "content-security-policy") {
        const existing = response.getHeader(key);
        const policies = Array.isArray(existing)
          ? existing.map(String)
          : existing === undefined
            ? []
            : [String(existing)];
        response.setHeader(key, [value, ...policies]);
      } else {
        response.setHeader(key, value);
      }
    }
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
    const rawResponseBody = await responseBody(upstream);
    copyResponseHeaders(upstream, response, origin, apiPort);
    response.statusCode = upstream.status;
    response.end(method === "HEAD" ? undefined : rawResponseBody);
  } catch (error) {
    if (response.headersSent) response.end();
    else {
      const status = requestErrorStatus(error);
      writeProxyError(
        response,
        status,
        status === StatusCodes.BAD_GATEWAY
          ? "data_plane_proxy_failed"
          : error instanceof Error
            ? error.message
            : "data_plane_proxy_failed",
        dataPlaneCorsHeaders(origin, apiPort),
      );
    }
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

async function proxyFixedSimulatorTarget(
  request: IncomingMessage,
  response: ServerResponse,
  resolveRoute: () => Promise<SimulatorDataPlaneRoute>,
  fetchFn: typeof fetch,
  closeSignal: AbortSignal,
  isClosing: () => boolean,
): Promise<void> {
  const origin = request.headers.origin;
  const listenerPort = request.socket.localPort;
  response.setHeader("content-security-policy", NO_WORKERS_CSP);
  if (!requestHeadersAllowed(request)) {
    writeProxyError(
      response,
      StatusCodes.REQUEST_HEADER_FIELDS_TOO_LARGE,
      "data_plane_headers_too_large",
    );
    return;
  }
  if (!fixedListenerHostAllowed(request.headers.host, listenerPort)) {
    writeProxyError(response, StatusCodes.MISDIRECTED_REQUEST, "data_plane_host_forbidden");
    return;
  }
  if (isClosing()) {
    writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
    return;
  }
  if (!browserOriginAllowed(origin, listenerPort)) {
    writeProxyError(response, StatusCodes.FORBIDDEN, "data_plane_browser_origin_forbidden");
    return;
  }
  const method = request.method ?? "GET";
  if (!dataPlaneMethodAllowed(method)) {
    writeProxyError(
      response,
      StatusCodes.BAD_REQUEST,
      "data_plane_method_invalid",
      dataPlaneCorsHeaders(origin, listenerPort),
    );
    return;
  }
  if (method === "OPTIONS" && origin !== undefined) {
    response.writeHead(StatusCodes.NO_CONTENT, dataPlaneCorsHeaders(origin, listenerPort));
    response.end();
    return;
  }
  if (method === "OPTIONS") {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "data_plane_method_invalid");
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!requestUrl.pathname.startsWith("/") || requestUrl.pathname.startsWith("//")) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return;
  }
  let route: SimulatorDataPlaneRoute;
  try {
    route = await resolveRouteWhileOpen(resolveRoute, closeSignal);
  } catch {
    if (isClosing()) {
      writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
      return;
    }
    writeProxyError(response, StatusCodes.NOT_FOUND, "unknown_simulator_target");
    return;
  }
  if (isClosing()) {
    writeProxyError(response, StatusCodes.SERVICE_UNAVAILABLE, "data_plane_listener_closing");
    return;
  }
  const targetUrl = upstreamUrl(route, requestUrl.pathname, requestUrl.search);
  if (!targetUrl) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return;
  }
  await forwardDataPlaneRequest(
    request,
    response,
    route,
    targetUrl,
    method,
    origin,
    listenerPort,
    fetchFn,
    closeSignal,
  );
}

/** Start one isolated loopback origin for exactly one problem target. */
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
      let closing: Promise<void> | undefined;
      accept({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => {
          if (closing) return closing;
          closeRequested = true;
          closing = (async () => {
            await new Promise<void>((resolveClose, rejectClose) => {
              let settled = false;
              let forceClose: NodeJS.Timeout | undefined;
              const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                if (forceClose) clearTimeout(forceClose);
                if (error) rejectClose(error);
                else resolveClose();
              };
              forceClose = setTimeout(() => {
                closeController.abort();
                for (const socket of sockets) socket.destroy();
                server.closeAllConnections();
                finish();
              }, DATA_PLANE_CLOSE_GRACE_MS);
              forceClose.unref();
              server.close((error) => finish(error ?? undefined));
              server.closeIdleConnections();
            });
            await Promise.allSettled([...activeHandlers]);
          })().catch((error) => {
            closing = undefined;
            throw error;
          });
          return closing;
        },
      });
    });
  });
}
