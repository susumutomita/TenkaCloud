import type { IncomingMessage, ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";
import type { LocalPlayState } from "./api-state";
import { corsHeaders, isAllowedCorsOrigin } from "./cors";
import { parseLoopbackUrl } from "./loopback";
import { SIMULATOR_DATA_PLANE_PREFIX } from "./simulator-data-plane";
import type { SimulatorDataPlaneRoute } from "./simulator-runtime";

const MAX_DATA_PLANE_BODY_BYTES = 64 * 1024;
const MAX_DATA_PLANE_HEADERS = 64;
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
  "x-tenkacloud-deployment-id",
  "x-tenkacloud-simulator-protocol",
  "x-tenkacloud-target-id",
  "x-tenkacloud-world-id",
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

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

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

function dataPlaneCorsHeaders(origin: string | undefined): Record<string, string> {
  const headers = corsHeaders(origin);
  if (headers["access-control-allow-origin"] === undefined) return headers;
  return { ...headers, "access-control-allow-methods": DATA_PLANE_ALLOW_METHODS };
}

function browserOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined || isAllowedCorsOrigin(origin);
}

function dataPlaneMethodAllowed(method: string): boolean {
  return method === "OPTIONS" || DATA_PLANE_METHODS.has(method);
}

function proxyMatch(pathname: string): RegExpExecArray | null {
  return new RegExp(`^${SIMULATOR_DATA_PLANE_PREFIX}/([^/]+)/([^/]+)(/.*)?$`).exec(pathname);
}

function simulatorRoute(
  state: LocalPlayState,
  problemId: string,
  targetId: string,
): SimulatorDataPlaneRoute | undefined {
  const problem = state.simulatedRuntimes.get(problemId)?.problem;
  if (!problem || !state.simulator) return undefined;
  try {
    return state.simulator.dataPlaneRoute(problem, targetId);
  } catch {
    return undefined;
  }
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
  return !HOP_BY_HOP_HEADERS.has(key) && !PRIVATE_REQUEST_HEADERS.has(key);
}

function appendHeader(headers: Headers, key: string, value: string | readonly string[]): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (item.length > 8192 || item.includes("\r") || item.includes("\n")) {
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
): void {
  for (const [key, value] of upstream.headers) {
    if (
      !HOP_BY_HOP_HEADERS.has(key) &&
      key !== "content-encoding" &&
      key !== "content-length" &&
      key !== "vary" &&
      key !== "timing-allow-origin" &&
      !key.startsWith("access-control-")
    ) {
      response.setHeader(key, value);
    }
  }
  for (const [key, value] of Object.entries(dataPlaneCorsHeaders(origin))) {
    response.setHeader(key, value);
  }
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
  fetchFn: typeof fetch,
): Promise<void> {
  try {
    const headers = upstreamHeaders(request, route.launchToken);
    const body = await requestBody(request);
    if ((method === "GET" || method === "HEAD") && body) {
      throw new Error("data_plane_method_body_forbidden");
    }
    const upstream = await fetchFn(targetUrl, {
      method,
      headers,
      redirect: "manual",
      ...(body ? { body } : {}),
    });
    const rawResponseBody = await responseBody(upstream);
    copyResponseHeaders(upstream, response, origin);
    response.statusCode = upstream.status;
    response.end(method === "HEAD" ? undefined : rawResponseBody);
  } catch (error) {
    if (response.headersSent) response.end();
    else {
      writeProxyError(
        response,
        requestErrorStatus(error),
        error instanceof Error ? error.message : "data_plane_proxy_failed",
        dataPlaneCorsHeaders(origin),
      );
    }
  }
}

/** Forward a participant HTTP request while keeping the launch token server-side. */
export async function proxySimulatorDataPlaneRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = proxyMatch(requestUrl.pathname);
  if (!match) return false;
  const origin = request.headers.origin;
  if (!browserOriginAllowed(origin)) {
    writeProxyError(response, StatusCodes.FORBIDDEN, "data_plane_browser_origin_forbidden");
    return true;
  }
  const method = request.method ?? "GET";
  if (!dataPlaneMethodAllowed(method)) {
    writeProxyError(
      response,
      StatusCodes.BAD_REQUEST,
      "data_plane_method_invalid",
      dataPlaneCorsHeaders(origin),
    );
    return true;
  }
  const problemId = match[1] ? decoded(match[1]) : undefined;
  const targetId = match[2] ? decoded(match[2]) : undefined;
  const tail = match[3] ?? "/";
  if (!problemId || !targetId || tail.startsWith("//")) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return true;
  }
  if (method === "OPTIONS" && origin !== undefined) {
    response.writeHead(StatusCodes.NO_CONTENT, dataPlaneCorsHeaders(origin));
    response.end();
    return true;
  }
  if (method === "OPTIONS") {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "data_plane_method_invalid");
    return true;
  }
  const route = simulatorRoute(state, problemId, targetId);
  if (!route) {
    writeProxyError(response, StatusCodes.NOT_FOUND, "unknown_simulator_target");
    return true;
  }
  const targetUrl = upstreamUrl(route, tail, requestUrl.search);
  if (!targetUrl) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_data_plane_route");
    return true;
  }
  await forwardDataPlaneRequest(request, response, route, targetUrl, method, origin, fetchFn);
  return true;
}
