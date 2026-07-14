import { existsSync, readFileSync } from "node:fs";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { StatusCodes } from "http-status-codes";

export const LOCAL_API_PROXY_PREFIX = "/__tenkacloud-local-api";
const MAX_PROXY_BODY_BYTES = 1_000_000;
const MAX_PROXY_HEADERS = 64;
const PROXY_TIMEOUT_MS = 15_000;
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
const PRIVATE_REQUEST_HEADERS = new Set(["cookie", "cookie2"]);
const PRIVATE_RESPONSE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "set-cookie2",
  "service-worker-allowed",
]);

interface LocalStateProjection {
  readonly apiBaseUrl?: unknown;
}

export interface LocalApiProxyOptions {
  readonly statePath?: string;
  readonly timeoutMs?: number;
  readonly request?: typeof request;
}

function defaultStatePath(): string {
  return resolve(
    process.env.TENKACLOUD_LOCAL_DIR ?? resolve(import.meta.dirname, "../..", ".tenkacloud/local"),
    "state.json",
  );
}

export function parseLocalApiProxyUrl(url: string | undefined): string | undefined {
  if (!url || (url !== LOCAL_API_PROXY_PREFIX && !url.startsWith(`${LOCAL_API_PROXY_PREFIX}/`))) {
    return undefined;
  }
  const path = url.slice(LOCAL_API_PROXY_PREFIX.length) || "/";
  const pathname = new URL(path, "http://127.0.0.1").pathname;
  if (pathname !== "/healthz" && !pathname.startsWith("/portal/")) return undefined;
  return path;
}

export function resolveLocalApiTarget(statePath = defaultStatePath()): URL | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as LocalStateProjection;
    if (typeof state.apiBaseUrl !== "string") return undefined;
    const url = new URL(state.apiBaseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
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

export function localApiRequestHeaders(
  source: IncomingHttpHeaders,
  target: URL,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  let count = 0;
  for (const [rawName, value] of Object.entries(source)) {
    const name = rawName.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || privateForwardingHeader(name)) {
      continue;
    }
    count += 1;
    if (count > MAX_PROXY_HEADERS) throw new Error("local_api_proxy_headers_too_large");
    headers[name] = value;
  }
  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  return headers;
}

function readBoundedBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_PROXY_BODY_BYTES) {
        reject(new Error("local_api_proxy_payload_too_large"));
        stream.destroy();
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => accept(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

function copyResponseHeaders(headers: IncomingHttpHeaders, response: ServerResponse): void {
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      PRIVATE_RESPONSE_HEADERS.has(name) ||
      name === "content-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
}

function writeProxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const message = error instanceof Error ? error.message : "local_api_proxy_failed";
  const status =
    message === "local_api_proxy_payload_too_large"
      ? StatusCodes.REQUEST_TOO_LONG
      : message === "local_api_proxy_headers_too_large"
        ? StatusCodes.BAD_REQUEST
        : StatusCodes.BAD_GATEWAY;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify({
      error: status === StatusCodes.BAD_GATEWAY ? "local_api_proxy_failed" : message,
    }),
  );
}

async function forwardLocalApiRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  path: string,
  options: LocalApiProxyOptions,
): Promise<void> {
  const target = resolveLocalApiTarget(options.statePath);
  if (!target) throw new Error("local_api_target_unavailable");
  const body = await readBoundedBody(incoming);
  const headers = localApiRequestHeaders(incoming.headers, target);
  await new Promise<void>((accept, reject) => {
    const upstream = (options.request ?? request)(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path,
        headers,
        timeout: options.timeoutMs ?? PROXY_TIMEOUT_MS,
      },
      async (upstreamResponse) => {
        try {
          const responseBody = await readBoundedBody(upstreamResponse);
          response.statusCode = upstreamResponse.statusCode ?? StatusCodes.BAD_GATEWAY;
          copyResponseHeaders(upstreamResponse.headers, response);
          response.setHeader("content-length", String(responseBody.length));
          response.end(responseBody);
          accept();
        } catch (error) {
          reject(error);
        }
      },
    );
    upstream.once("timeout", () => upstream.destroy(new Error("local_api_proxy_timeout")));
    upstream.once("error", reject);
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}

/** Codespaces-only fixed Participant API bridge; arbitrary challenge ports stay isolated. */
export function createLocalApiProxyMiddleware(options: LocalApiProxyOptions = {}) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = parseLocalApiProxyUrl(request.url);
    if (!path) {
      next();
      return;
    }
    void forwardLocalApiRequest(request, response, path, options).catch((error) => {
      writeProxyError(response, error);
    });
  };
}
