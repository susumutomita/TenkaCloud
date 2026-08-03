import type { IncomingMessage, ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";
import { compareCodePoints } from "../lib/code-point-order";
import type { LocalPlayState } from "./api-state";
import { parseLoopbackUrl } from "./loopback";
import type { SimulatorNativeRoute } from "./simulator-native-environment";

export const SIMULATOR_NATIVE_PROXY_PREFIX = "/local/simulator-native";
const MAX_NATIVE_BODY_BYTES = 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;
const NATIVE_UPSTREAM_TIMEOUT_MS = 10_000;
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
const SIGV4_AUTHORIZATION =
  /^(AWS4-HMAC-SHA256 Credential=[^,\r\n]+,\s*SignedHeaders=)([a-z0-9;-]+)(,\s*Signature=[a-f0-9]{64})$/;
const SIMULATOR_ROUTING_HEADERS = [
  "x-tenkacloud-deployment-id",
  "x-tenkacloud-target-id",
  "x-tenkacloud-world-id",
] as const;
const PRIVATE_REQUEST_HEADERS = new Set(["cookie"]);
const PRIVATE_RESPONSE_HEADERS = new Set([
  "authentication-info",
  "authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "service-worker-allowed",
]);

function privateForwardingHeader(name: string): boolean {
  return (
    name === "forwarded" ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("x-github-") ||
    name.startsWith("x-original-") ||
    name.startsWith("cf-")
  );
}

export interface SimulatorNativeProxyOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_NATIVE_BODY_BYTES) throw new Error("native_payload_too_large");
    chunks.push(bytes);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function upstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (
      HOP_BY_HOP_HEADERS.has(key) ||
      PRIVATE_REQUEST_HEADERS.has(key) ||
      privateForwardingHeader(key) ||
      value === undefined
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else headers.set(key, value);
  }
  return headers;
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
    if (total > MAX_NATIVE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("native_response_too_large");
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

function declareInjectedRoutingHeaders(headers: Headers): void {
  const authorization = headers.get("authorization");
  const match = authorization ? SIGV4_AUTHORIZATION.exec(authorization) : null;
  if (!match) return;
  const signedHeaders = new Set((match[2] ?? "").split(";"));
  for (const header of SIMULATOR_ROUTING_HEADERS) signedHeaders.add(header);
  headers.set(
    "authorization",
    `${match[1]}${[...signedHeaders].sort(compareCodePoints).join(";")}${match[3]}`,
  );
}

function writeProxyError(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

function proxyMatch(pathname: string): RegExpExecArray | null {
  return new RegExp(`^${SIMULATOR_NATIVE_PROXY_PREFIX}/([^/]+)/([^/]+)(/.*)?$`).exec(pathname);
}

async function simulatorRoute(
  state: LocalPlayState,
  problemId: string,
  targetId: string,
): Promise<SimulatorNativeRoute | undefined> {
  const problem = state.simulatedRuntimes.get(problemId)?.problem;
  if (!problem || !state.simulator) return undefined;
  try {
    return await state.simulator.nativeRoute(problem, targetId);
  } catch {
    return undefined;
  }
}

function nativeUpstreamUrl(
  route: SimulatorNativeRoute,
  tail: string,
  search: string,
): URL | undefined {
  const base = parseLoopbackUrl(route.upstreamBaseUrl, "Simulator native upstream");
  const upstream = new URL(`${tail}${search}`, `${base.toString().replace(/\/$/, "")}/`);
  return upstream.origin === base.origin ? upstream : undefined;
}

function copyUpstreamHeaders(upstream: Response, response: ServerResponse): void {
  for (const [key, value] of upstream.headers) {
    if (
      !HOP_BY_HOP_HEADERS.has(key) &&
      !PRIVATE_RESPONSE_HEADERS.has(key) &&
      key !== "content-encoding"
    ) {
      response.setHeader(key, value);
    }
  }
}

async function fetchNativeResponse(
  request: IncomingMessage,
  route: SimulatorNativeRoute,
  upstreamUrl: URL,
  options: Required<SimulatorNativeProxyOptions>,
): Promise<readonly [Response, Uint8Array]> {
  const headers = upstreamHeaders(request);
  headers.set("x-tenkacloud-world-id", route.worldId);
  headers.set("x-tenkacloud-deployment-id", route.deploymentId);
  headers.set("x-tenkacloud-target-id", route.targetId);
  // Simulator-owned credentials are syntax-checked but never accepted by real
  // AWS. The loopback proxy owns the injected routing values, so it also adds
  // those header names to the local SigV4 metadata before forwarding.
  declareInjectedRoutingHeaders(headers);
  const body = await requestBody(request);
  const upstream = await options.fetchFn(upstreamUrl, {
    method: request.method ?? "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
    ...(body ? { body } : {}),
  });
  return [upstream, await responseBody(upstream)];
}

function writeNativeRequestError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payloadTooLarge = error instanceof Error && error.message === "native_payload_too_large";
  writeProxyError(
    response,
    payloadTooLarge ? StatusCodes.REQUEST_TOO_LONG : StatusCodes.BAD_GATEWAY,
    payloadTooLarge ? "native_payload_too_large" : "native_proxy_failed",
  );
}

async function forwardNativeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: SimulatorNativeRoute,
  upstreamUrl: URL,
  options: Required<SimulatorNativeProxyOptions>,
): Promise<void> {
  try {
    const [upstream, rawResponseBody] = await fetchNativeResponse(
      request,
      route,
      upstreamUrl,
      options,
    );
    copyUpstreamHeaders(upstream, response);
    response.statusCode = upstream.status;
    response.end(rawResponseBody);
  } catch (error) {
    writeNativeRequestError(response, error);
  }
}

/**
 * Forward one provider-native request to Simulator while injecting only the
 * route headers standard provider CLIs cannot set. Authorization and payload
 * remain byte-for-byte client owned; provider semantics stay in Simulator.
 */
export async function proxySimulatorNativeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
  options: SimulatorNativeProxyOptions = {},
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = proxyMatch(requestUrl.pathname);
  if (!match) return false;
  if (request.headers.origin) {
    writeProxyError(response, StatusCodes.FORBIDDEN, "native_proxy_forbids_browser_origin");
    return true;
  }
  const problemId = match[1] ? decoded(match[1]) : undefined;
  const targetId = match[2] ? decoded(match[2]) : undefined;
  const tail = match[3] ?? "/";
  if (!problemId || !targetId || tail.startsWith("//")) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_native_route");
    return true;
  }
  const route = await simulatorRoute(state, problemId, targetId);
  if (!route) {
    writeProxyError(response, StatusCodes.NOT_FOUND, "unknown_simulator_target");
    return true;
  }
  const upstreamUrl = nativeUpstreamUrl(route, tail, requestUrl.search);
  if (!upstreamUrl) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_native_route");
    return true;
  }
  await forwardNativeRequest(request, response, route, upstreamUrl, {
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? NATIVE_UPSTREAM_TIMEOUT_MS,
  });
  return true;
}
