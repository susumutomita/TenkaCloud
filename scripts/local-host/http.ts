import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { HostError } from "./model";
import type { HostingService } from "./service";
export const MAX_BODY = 64 * 1024;

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(
    status,
    {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  );
  response.end(JSON.stringify(body));
}

export function errorResponse(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const known = error instanceof HostError;
  json(
    response,
    known ? error.status : 500,
    {
      error: known ? error.kind : "internal_error",
      kind: known ? error.kind : "internal_error",
      message: known ? error.message : "Local-host request failed. Check the host terminal."
    }
  );
}

export async function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new HostError(413, "Request body is too large.");
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
  if (request.headers.host !== new URL(origin).host) throw new HostError(403, "Untrusted Host header.");
  if (request.headers.origin && request.headers.origin !== origin) throw new HostError(403, "Cross-origin requests are not allowed.");
  if (request.headers["sec-fetch-site"] === "cross-site") throw new HostError(403, "Cross-site requests are not allowed.");
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
  if (!address || typeof address === "string") throw new Error("The HTTP server has no TCP address.");
  return `http://${hostname}:${address.port}`;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
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

async function serveStatic(response: ServerResponse, pathname: string, root: string): Promise<void> {
  const safeRoot = await realpath(root);
  let file: string;
  let contentType: string;
  if (pathname.startsWith("/assets/")) {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\\") || decoded.split("/").some(part => part.startsWith("."))) throw new HostError(404, "Asset not found.");
    contentType = contentTypes[extname(decoded)] ?? "";
    if (!contentType) throw new HostError(404, "Asset type is not served.");
    try {
      file = await realpath(resolve(safeRoot, `.${decoded}`));
    }
    catch {
      throw new HostError(404, "Asset not found.");
    }
    if (!file.startsWith(`${safeRoot}${sep}`)) throw new HostError(404, "Asset not found.");
  } else if (pathname === "/plugin-versions.json") {
    file = await realpath(resolve(safeRoot, "plugin-versions.json"));
    if (!file.startsWith(`${safeRoot}${sep}`)) throw new HostError(404, "File not served.");
    contentType = "application/json; charset=utf-8";
  } else {
    // No state directory, JSON metadata, sourcemap or repository file is ever served.
    if (/\.[a-zA-Z0-9]+$/u.test(pathname)) throw new HostError(404, "File not served.");
    file = resolve(safeRoot, "host.html");
    contentType = "text/html; charset=utf-8";
  }
  response.writeHead(
    200,
    {
      "content-type": contentType,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  );
  response.end(await readFile(file));
}

export interface HttpHost { origin: string; close(): Promise<void> }
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
  if (options.kind === "admin" && options.hostname !== "127.0.0.1") throw new Error("The host console must bind to IPv4 loopback.");
  let origin = "";
  const failures = new Map<string, {
    count: number;
    reset: number
  }>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!(error instanceof HostError)) (options.log ?? console.error)(error);
      errorResponse(response, error);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;
  server.setTimeout(15_000, socket => socket.destroy());
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    validOrigin(request, origin);
    const url = new URL(request.url ?? "/", origin);
    try {
      decodeURIComponent(url.pathname);
    }
    catch {
      throw new HostError(400, "Malformed URL encoding.");
    }
    if (url.origin !== origin) throw new HostError(403, "Absolute cross-origin request target is forbidden.");
    if (url.pathname === "/healthz" && request.method === "GET") {
      json(response, 200, {
        status: "ok",
        mode: "local-host",
        role: options.kind
      });
      return;
    }
    if (url.pathname === "/runtime-config.json" && request.method === "GET") {
      json(
        response,
        200,
        {
          mode: "local-host",
          apiBaseUrl: `${origin}/api`,
          participantPortalUrl: options.participantOrigin,
          role: options.kind
        }
      );
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") throw new HostError(405, "Only GET is allowed for the application.");
      await serveStatic(response, url.pathname, options.staticRoot);
      return;
    }
    const path = url.pathname.slice(4);
    // Compatibility with the existing memory-only AuthProvider's revocation flow.
    // This is a local endpoint, not a call to Cognito; redirect destinations are fixed.
    if (options.kind === "admin" && path === "/host/oauth2/revoke" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new HostError(415, "Use form-encoded token revocation.");
      const token = new URLSearchParams(await readBody(request)).get("token") ?? "";
      options.service.store.revokeSession(token);
      json(response, 200, { revoked: true });
      return;
    }
    if (options.kind === "admin" && path === "/host/logout" && request.method === "GET") {
      response.writeHead(303, { location: "/login", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (options.kind === "participant" && !path.startsWith("/portal/")) throw new HostError(404, "Unknown participant endpoint.");
    if (options.kind === "admin" && path.startsWith("/portal/")) throw new HostError(404, "Unknown host endpoint.");
    const remote = request.socket.remoteAddress ?? "unknown";
    const now = options.service.now();
    for (const [key, value] of failures) if (value.reset <= now) failures.delete(key);
    if ((failures.get(remote)?.count ?? 0) >= 10) throw new HostError(429, "Too many invalid credentials; retry in one minute.");
    let body: unknown = {};
    if ([
      "POST",
      "PATCH",
      "PUT",
      "DELETE"
    ].includes(request.method ?? "")) {
      const raw = await readBody(request);
      if (raw) {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new HostError(415, "Use application/json.");
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          throw new HostError(400, "Malformed JSON.");
        }
      }
    }
    const auth = request.headers.authorization ?? "";
    if (auth.length > 4096) throw new HostError(401, "Invalid credential.");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const nonce = request.headers["idempotency-key"];
    if (Array.isArray(nonce)) throw new HostError(400, "Only one Idempotency-Key is allowed.");
    try {
      const apiRequest = {
        method: request.method ?? "GET",
        path,
        query: url.searchParams,
        body,
        token,
        nonce
      };
      const result = options.kind === "admin" ? await options.service.admin(apiRequest) : await options.service.participant(apiRequest);
      json(response, result.status, result.body);
    } catch (error) {
      if (error instanceof HostError && error.status === 401) {
        const current = failures.get(remote) ?? { count: 0, reset: now + 60_000 };
        current.count += 1;
        // Bound the map as well as the rate. Only a LAN address can reach this listener.
        if (failures.size < 4096 || failures.has(remote)) failures.set(remote, current);
      }
      throw error;
    }
  }
  origin = await listen(server, options.hostname, options.port);
  return { origin, close: () => closeServer(server) };
}
