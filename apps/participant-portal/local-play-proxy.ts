import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";

export const LOCAL_CHALLENGE_PROXY_PREFIX = "/__tenkacloud-local-port";

export interface LocalChallengeProxyTarget {
  readonly port: number;
  readonly path: string;
}

export function parseLocalChallengeProxyUrl(
  url: string | undefined,
): LocalChallengeProxyTarget | undefined {
  if (!url?.startsWith(`${LOCAL_CHALLENGE_PROXY_PREFIX}/`)) return undefined;
  const rest = url.slice(LOCAL_CHALLENGE_PROXY_PREFIX.length + 1);
  const pathStart = rest.search(/[/?]/);
  const rawPort = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const rawPath = pathStart === -1 ? "" : rest.slice(pathStart);
  return {
    port,
    path: rawPath.length === 0 ? "/" : rawPath.startsWith("?") ? `/${rawPath}` : rawPath,
  };
}

export function rewriteLoopbackUrlPrefixes(
  value: string,
  forwardedPrefix = LOCAL_CHALLENGE_PROXY_PREFIX,
): string {
  return value.replace(
    /\bhttp:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=\/|[?#]|[\s`"'<>)]|$)/g,
    (_match, port: string) => `${forwardedPrefix}/${port}`,
  );
}

export const rewriteLoopbackLocationHeader = rewriteLoopbackUrlPrefixes;

export function rewritesBody(headers: IncomingMessage["headers"]): boolean {
  const encoding = headers["content-encoding"];
  if (encoding && encoding !== "identity") return false;
  const type = String(headers["content-type"] ?? "").toLowerCase();
  return (
    type.includes("text/html") ||
    type.includes("text/css") ||
    type.includes("javascript") ||
    type.includes("application/json")
  );
}

export function copyProxyHeaders(headers: IncomingMessage["headers"], res: ServerResponse): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === "content-length" && rewritesBody(headers)) continue;
    if (name.toLowerCase() === "location") {
      const raw = Array.isArray(value) ? value[0] : value;
      if (raw) res.setHeader(name, rewriteLoopbackLocationHeader(raw));
      continue;
    }
    res.setHeader(name, value);
  }
}

export function proxyStatusCode(statusCode: number | undefined): number {
  return statusCode ?? StatusCodes.BAD_GATEWAY;
}

export function handleProxyError(
  error: NodeJS.ErrnoException,
  res: ServerResponse,
  port: number,
): void {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  res.statusCode =
    error.code === "ECONNREFUSED" ? StatusCodes.BAD_GATEWAY : StatusCodes.INTERNAL_SERVER_ERROR;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(`Local challenge proxy failed for port ${port}: ${error.message}`);
}

export function proxyResponseBody(upstreamRes: IncomingMessage, res: ServerResponse): void {
  if (!rewritesBody(upstreamRes.headers)) {
    upstreamRes.pipe(res);
    return;
  }

  const chunks: Buffer[] = [];
  upstreamRes.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  upstreamRes.on("end", () => {
    res.end(rewriteLoopbackUrlPrefixes(Buffer.concat(chunks).toString("utf8")));
  });
}

export function createLocalChallengeProxyMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const target = parseLocalChallengeProxyUrl(req.url);
    if (!target) {
      next();
      return;
    }

    const headers = {
      ...req.headers,
      "accept-encoding": "identity",
      host: `127.0.0.1:${target.port}`,
    };
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        method: req.method,
        path: target.path,
        headers,
      },
      (upstreamRes) => {
        res.statusCode = proxyStatusCode(upstreamRes.statusCode);
        copyProxyHeaders(upstreamRes.headers, res);
        proxyResponseBody(upstreamRes, res);
      },
    );

    upstream.on("error", (error: NodeJS.ErrnoException) => {
      handleProxyError(error, res, target.port);
    });

    req.pipe(upstream);
  };
}
