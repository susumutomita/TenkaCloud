import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { HostError } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";
export const MAX_BODY = 64 * 1024;

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

export function errorResponse(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const known = error instanceof HostError;
  json(response, known ? error.status : 500, {
    error: known ? error.kind : "internal_error",
    kind: known ? error.kind : "internal_error",
    message: known ? error.message : "Local-host request failed. Check the host terminal.",
  });
}

export async function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit))
    throw new HostError(413, "Request body is too large.");
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += bytes.byteLength;
    if (total > limit) throw new HostError(413, "Request body is too large.");
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString("utf8");
}

function validOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host)
    throw new HostError(403, "Untrusted Host header.");
  if (request.headers.origin && request.headers.origin !== origin)
    throw new HostError(403, "Cross-origin requests are not allowed.");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new HostError(403, "Cross-site requests are not allowed.");
}

export async function listen(server: Server, hostname: string, port: number): Promise<string> {
  await new Promise<void>((accept, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, hostname, () => {
      server.off("error", failed);
      accept();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The HTTP server has no TCP address.");
  return `http://${hostname}:${address.port}`;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}
const contentTypes: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

interface StaticFile {
  file: string;
  contentType: string;
}

async function resolveAsset(safeRoot: string, pathname: string): Promise<StaticFile> {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\\") || decoded.split("/").some((part) => part.startsWith(".")))
    throw new HostError(404, "Asset not found.");
  const contentType = contentTypes[extname(decoded)] ?? "";
  if (!contentType) throw new HostError(404, "Asset type is not served.");
  let file: string;
  try {
    file = await realpath(resolve(safeRoot, `.${decoded}`));
  } catch {
    throw new HostError(404, "Asset not found.");
  }
  if (!file.startsWith(`${safeRoot}${sep}`)) throw new HostError(404, "Asset not found.");
  return { file, contentType };
}

async function resolveStatic(safeRoot: string, pathname: string): Promise<StaticFile> {
  if (pathname.startsWith("/assets/")) return resolveAsset(safeRoot, pathname);
  if (pathname === "/plugin-versions.json") {
    const file = await realpath(resolve(safeRoot, "plugin-versions.json"));
    if (!file.startsWith(`${safeRoot}${sep}`)) throw new HostError(404, "File not served.");
    return { file, contentType: "application/json; charset=utf-8" };
  }
  // No state directory, JSON metadata, sourcemap or repository file is ever served.
  if (/\.[a-zA-Z0-9]+$/u.test(pathname)) throw new HostError(404, "File not served.");
  return { file: resolve(safeRoot, "host.html"), contentType: "text/html; charset=utf-8" };
}

async function serveStatic(
  response: ServerResponse,
  pathname: string,
  root: string,
): Promise<void> {
  const { file, contentType } = await resolveStatic(await realpath(root), pathname);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(await readFile(file));
}

export interface HttpHost {
  origin: string;
  close(): Promise<void>;
}

/** Ten invalid credentials per remote address per minute; the map itself is bounded too. */
class InvalidCredentialLimiter {
  private readonly failures = new Map<string, { count: number; reset: number }>();
  constructor(private readonly now: () => number) {}
  assertAllowed(remote: string): void {
    const now = this.now();
    for (const [key, value] of this.failures) if (value.reset <= now) this.failures.delete(key);
    if ((this.failures.get(remote)?.count ?? 0) >= 10)
      throw new HostError(429, "Too many invalid credentials; retry in one minute.");
  }
  record(remote: string): void {
    const current = this.failures.get(remote) ?? { count: 0, reset: this.now() + 60_000 };
    current.count += 1;
    // Only a LAN address can reach this listener; still cap the map, not just the rate.
    if (this.failures.size < 4096 || this.failures.has(remote)) this.failures.set(remote, current);
  }
}

function requestTarget(request: IncomingMessage, origin: string): URL {
  const url = new URL(request.url ?? "/", origin);
  try {
    decodeURIComponent(url.pathname);
  } catch {
    throw new HostError(400, "Malformed URL encoding.");
  }
  if (url.origin !== origin)
    throw new HostError(403, "Absolute cross-origin request target is forbidden.");
  return url;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method ?? "")) return {};
  const raw = await readBody(request);
  if (!raw) return {};
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
    throw new HostError(415, "Use application/json.");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HostError(400, "Malformed JSON.");
  }
}

function bearerToken(request: IncomingMessage): string {
  const auth = request.headers.authorization ?? "";
  if (auth.length > 4096) throw new HostError(401, "Invalid credential.");
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const nonce = request.headers["idempotency-key"];
  if (Array.isArray(nonce)) throw new HostError(400, "Only one Idempotency-Key is allowed.");
  return nonce;
}

/** Distinct origins: the admin listener is loopback-only and has no participant routes. */
export async function startHttpHost(options: {
  kind: "admin" | "participant";
  hostname: string;
  port: number;
  staticRoot: string;
  service: HostingService;
  participantOrigin?: string;
  log?: (error: unknown) => void;
}): Promise<HttpHost> {
  if (options.kind === "admin" && options.hostname !== "127.0.0.1")
    throw new Error("The host console must bind to IPv4 loopback.");
  let origin = "";
  const limiter = new InvalidCredentialLimiter(options.service.now);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!(error instanceof HostError)) (options.log ?? console.error)(error);
      errorResponse(response, error);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;
  server.setTimeout(15_000, (socket) => socket.destroy());
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    validOrigin(request, origin);
    const url = requestTarget(request, origin);
    if (url.pathname === "/healthz" && request.method === "GET") {
      json(response, 200, { status: "ok", mode: "local-host", role: options.kind });
      return;
    }
    if (url.pathname === "/runtime-config.json" && request.method === "GET") {
      json(response, 200, {
        mode: "local-host",
        apiBaseUrl: `${origin}/api`,
        participantPortalUrl: options.participantOrigin,
        role: options.kind,
      });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET")
        throw new HostError(405, "Only GET is allowed for the application.");
      await serveStatic(response, url.pathname, options.staticRoot);
      return;
    }
    await handleApi(request, response, url.pathname.slice(4), url.searchParams);
  }
  // Compatibility with the existing memory-only AuthProvider's revocation flow. These are
  // local endpoints, not calls to Cognito; redirect destinations are fixed.
  async function handleSessionCompat(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<boolean> {
    if (options.kind !== "admin") return false;
    if (path === "/host/oauth2/revoke" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"))
        throw new HostError(415, "Use form-encoded token revocation.");
      const token = new URLSearchParams(await readBody(request)).get("token") ?? "";
      options.service.store.revokeSession(token);
      json(response, 200, { revoked: true });
      return true;
    }
    if (path === "/host/logout" && request.method === "GET") {
      response.writeHead(303, { location: "/login", "cache-control": "no-store" });
      response.end();
      return true;
    }
    return false;
  }
  function assertRoleRoute(path: string): void {
    const participantRoute = path.startsWith("/portal/");
    if (options.kind === "participant" && !participantRoute)
      throw new HostError(404, "Unknown participant endpoint.");
    if (options.kind === "admin" && participantRoute)
      throw new HostError(404, "Unknown host endpoint.");
  }
  async function dispatch(apiRequest: ApiRequest): Promise<ApiResponse> {
    return options.kind === "admin"
      ? options.service.admin(apiRequest)
      : options.service.participant(apiRequest);
  }
  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (await handleSessionCompat(request, response, path)) return;
    assertRoleRoute(path);
    const remote = request.socket.remoteAddress ?? "unknown";
    limiter.assertAllowed(remote);
    const apiRequest: ApiRequest = {
      method: request.method ?? "GET",
      path,
      query,
      body: await jsonBody(request),
      token: bearerToken(request),
      nonce: idempotencyKey(request),
    };
    try {
      const result = await dispatch(apiRequest);
      json(response, result.status, result.body);
    } catch (error) {
      if (error instanceof HostError && error.status === 401) limiter.record(remote);
      throw error;
    }
  }
  origin = await listen(server, options.hostname, options.port);
  return { origin, close: () => closeServer(server) };
}
