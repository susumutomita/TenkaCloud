import type { IncomingMessage, ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";
import type { LocalPlayState } from "./api-state";
import { parseLoopbackUrl } from "./loopback";
import type { SimulatorNativeRoute } from "./simulator-native-environment";

export const SIMULATOR_NATIVE_PROXY_PREFIX = "/local/simulator-native";
const MAX_NATIVE_BODY_BYTES = 1024 * 1024;
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
    if (HOP_BY_HOP_HEADERS.has(key) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else headers.set(key, value);
  }
  return headers;
}

function writeProxyError(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

function proxyMatch(pathname: string): RegExpExecArray | null {
  return new RegExp(`^${SIMULATOR_NATIVE_PROXY_PREFIX}/([^/]+)/([^/]+)(/.*)?$`).exec(pathname);
}

function simulatorRoute(
  state: LocalPlayState,
  problemId: string,
  targetId: string,
): SimulatorNativeRoute | undefined {
  const problem = state.simulatedRuntimes.get(problemId)?.problem;
  if (!problem || !state.simulator) return undefined;
  try {
    return state.simulator.nativeRoute(problem, targetId);
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
    if (!HOP_BY_HOP_HEADERS.has(key) && key !== "content-encoding") {
      response.setHeader(key, value);
    }
  }
}

async function forwardNativeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: SimulatorNativeRoute,
  upstreamUrl: URL,
): Promise<void> {
  const headers = upstreamHeaders(request);
  headers.set("x-tenkacloud-world-id", route.worldId);
  headers.set("x-tenkacloud-deployment-id", route.deploymentId);
  headers.set("x-tenkacloud-target-id", route.targetId);
  try {
    const body = await requestBody(request);
    const upstream = await fetch(upstreamUrl, {
      method: request.method ?? "GET",
      headers,
      redirect: "manual",
      ...(body ? { body } : {}),
    });
    copyUpstreamHeaders(upstream, response);
    response.statusCode = upstream.status;
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    if (response.headersSent) response.end();
    else {
      writeProxyError(
        response,
        error instanceof Error && error.message === "native_payload_too_large"
          ? StatusCodes.REQUEST_TOO_LONG
          : StatusCodes.BAD_GATEWAY,
        error instanceof Error ? error.message : "native_proxy_failed",
      );
    }
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
  const route = simulatorRoute(state, problemId, targetId);
  if (!route) {
    writeProxyError(response, StatusCodes.NOT_FOUND, "unknown_simulator_target");
    return true;
  }
  const upstreamUrl = nativeUpstreamUrl(route, tail, requestUrl.search);
  if (!upstreamUrl) {
    writeProxyError(response, StatusCodes.BAD_REQUEST, "invalid_native_route");
    return true;
  }
  await forwardNativeRequest(request, response, route, upstreamUrl);
  return true;
}
