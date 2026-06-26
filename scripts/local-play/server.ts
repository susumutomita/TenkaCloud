import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StatusCodes } from "http-status-codes";
import { createLocalPlayState, handleLocalPlayRequest, type LocalPlayState } from "./api";
import type { LocalPlayDeployment } from "./kumo";

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

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  state: LocalPlayState,
): Promise<void> {
  if (request.method === "OPTIONS") {
    writeJson(response, StatusCodes.NO_CONTENT, undefined);
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const query = Object.fromEntries(url.searchParams);
  const body = await readJsonBody(request);
  const result = handleLocalPlayRequest(
    {
      method: request.method ?? "GET",
      path: url.pathname,
      query,
      body,
    },
    state,
  );
  writeJson(response, result.status, result.body);
}

export function startLocalPlayServer(
  port: number,
  deployment: LocalPlayDeployment,
): Promise<LocalPlayServer> {
  const state = createLocalPlayState(deployment);
  const server: Server = createServer((request, response) => {
    void route(request, response, state).catch((error) => {
      const message = error instanceof Error ? error.message : "internal";
      const status =
        message === "payload_too_large"
          ? StatusCodes.REQUEST_TOO_LONG
          : message === "invalid_json"
            ? StatusCodes.BAD_REQUEST
            : StatusCodes.INTERNAL_SERVER_ERROR;
      if (!response.headersSent) writeJson(response, status, { error: message });
      else response.end();
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
