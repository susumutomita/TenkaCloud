import type { IncomingMessage, ServerResponse } from "node:http";
import { HostError, type Job } from "./model";
import { digest } from "./store";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const MAX_BYTES = 2 * 1024 * 1024;

function privatePath(path: string, denied: readonly string[]): boolean {
  let decoded = path;
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  const pathOnly = `/${decoded.replaceAll("\\", "/").split("/").filter(Boolean).join("/")}`;
  const canonical = new URL(pathOnly, "http://127.0.0.1").pathname.toLowerCase();
  return denied.some((entry) => {
    let prefix = entry.toLowerCase();
    while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
    return canonical === prefix || canonical.startsWith(`${prefix}/`);
  });
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES))
    throw new HostError(413, "Challenge request exceeded its limit.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > MAX_BYTES) throw new HostError(413, "Challenge request exceeded its limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function responseBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_BYTES) throw new HostError(502, "Challenge response exceeded its limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function upstreamHeaders(
  request: IncomingMessage,
  origin: string,
  keyHash: string,
  cookiePrefix: string,
): Headers {
  const headers = new Headers({ host: new URL(origin).host });
  for (const name of ["accept", "content-type", "range", "if-none-match", "if-modified-since"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const authorization = request.headers.authorization;
  if (authorization && digest(authorization.replace(/^Bearer\s+/iu, "").trim()) !== keyHash)
    headers.set("authorization", authorization);
  const cookies = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(cookiePrefix))
    .map((part) => part.slice(cookiePrefix.length));
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  if (request.headers.origin) headers.set("origin", origin);
  headers.set("x-forwarded-host", new URL(origin).host);
  headers.set("x-forwarded-proto", new URL(origin).protocol.slice(0, -1));
  return headers;
}

function applicationCookies(response: Response, cookiePrefix: string): string[] {
  return response.headers
    .getSetCookie()
    .filter((value) => !value.trimStart().startsWith("tc_exercise_"))
    .map(
      (value) =>
        cookiePrefix +
        value
          .trimStart()
          .split(";")
          .filter((part) => !/^\s*domain=/iu.test(part))
          .join(";"),
    );
}

function applicationHeaders(
  result: Response,
  target: URL,
  upstream: URL,
  origin: string,
  cookiePrefix: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {
    "content-type": result.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy":
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  };
  const location = result.headers.get("location");
  if (location) {
    const next = new URL(location, target);
    if (next.origin !== upstream.origin && next.origin !== origin)
      throw new HostError(502, "Challenge redirected outside its owned application.");
    headers.location = `${origin}${next.pathname}${next.search}${next.hash}`;
  }
  const disposition = result.headers.get("content-disposition");
  if (disposition) headers["content-disposition"] = disposition;
  const cookies = applicationCookies(result, cookiePrefix);
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

/** Proxy only the immutable owned application origin; never a caller-selected destination. */
export async function proxyApplication(args: {
  request: IncomingMessage;
  response: ServerResponse;
  upstream: URL;
  origin: string;
  deniedPaths: readonly string[];
  keyHash: string;
  authorize: () => Job;
}): Promise<void> {
  const { request, response } = args;
  const method = request.method ?? "GET";
  if (!METHODS.has(method)) throw new HostError(405, "Unsupported challenge method.");
  const incoming = new URL(request.url ?? "/", args.origin);
  if (privatePath(incoming.pathname, args.deniedPaths))
    throw new HostError(404, "The verifier is not a public challenge endpoint.");
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (hasBody && request.headers.origin !== args.origin)
    throw new HostError(403, "A same-origin challenge request is required.");
  const body = hasBody ? await requestBody(request) : undefined;
  const forwarded = args.authorize();
  // Cookies ignore TCP ports. Namespace server-managed challenge cookies per job
  // so another exercise cannot receive or overwrite them on this shared hostname.
  const cookiePrefix = `tc_app_${digest(forwarded.jobId).slice(0, 24)}_`;
  const target = new URL(args.upstream.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const result = await fetch(target, {
    method,
    body: body ? new Uint8Array(body).buffer : undefined,
    headers: upstreamHeaders(request, args.origin, args.keyHash, cookiePrefix),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const payload = await responseBody(result);
  const current = args.authorize();
  if (
    current.unit !== forwarded.unit ||
    current.definition !== forwarded.definition ||
    current.deployedAt !== forwarded.deployedAt
  )
    throw new HostError(409, "This environment changed. Open it again from the portal.");
  const headers = applicationHeaders(result, target, args.upstream, args.origin, cookiePrefix);
  response.writeHead(result.status, headers);
  response.end(payload);
}
