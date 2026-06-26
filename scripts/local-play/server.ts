import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";
import {
  type CreateStateOptions,
  createLocalPlayState,
  handleLocalPlayRequest,
  type LocalPlayDeployment,
  type LocalPlayState,
} from "./api";
import { isLoopbackUrl } from "./loopback";

const MAX_BODY_BYTES = 1_000_000;

export interface LocalPlayServer {
  readonly port: number;
  readonly state: LocalPlayState;
  readonly close: () => Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

/**
 * CORS for the loopback scoring API. We reflect the request Origin only when it
 * is itself a loopback origin (the Participant Portal dev server), and send no
 * `access-control-allow-origin` otherwise. A wildcard would let any website the
 * participant has open drive the local API cross-origin (submit flags, reveal
 * penalty hints, rename the team) — the loopback bind alone does not stop a
 * browser on the same machine.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !isLoopbackUrl(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string>,
): void {
  response.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
): Promise<void> {
  const cors = corsHeaders(request.headers.origin);
  if (request.method === "OPTIONS") {
    writeJson(response, StatusCodes.NO_CONTENT, undefined, cors);
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const query = Object.fromEntries(url.searchParams);
  const body = await readJsonBody(request);
  const result = await handleLocalPlayRequest(
    {
      method: request.method ?? "GET",
      path: url.pathname,
      query,
      body,
    },
    state,
  );
  writeJson(response, result.status, result.body, cors);
}

export function startLocalPlayServer(
  port: number,
  deployment: LocalPlayDeployment,
  options: CreateStateOptions = {},
): Promise<LocalPlayServer> {
  const state = createLocalPlayState(deployment, options);
  const server: Server = createServer((request, response) => {
    void route(request, response, state).catch((error) => {
      const message = error instanceof Error ? error.message : "internal";
      const status =
        message === "payload_too_large"
          ? StatusCodes.REQUEST_TOO_LONG
          : message === "invalid_json"
            ? StatusCodes.BAD_REQUEST
            : StatusCodes.INTERNAL_SERVER_ERROR;
      if (!response.headersSent) {
        writeJson(response, status, { error: message }, corsHeaders(request.headers.origin));
      } else response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        state,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
