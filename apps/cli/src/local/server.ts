/**
 * Issue #1975: local Participant API の node:http ラッパ。 純ルーター `handleLocalRequest`
 * (api.ts) を HTTP に繋ぐだけの薄い層。 CORS は participant-portal (別 origin: vite dev /
 * 静的配信) から叩けるよう許可する (local only、 bearer は検証しない)。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createLocalState, handleLocalRequest, type LocalState } from "./api.ts";
import type { LocalCatalogProblem } from "./catalog.ts";

export interface LocalServerHandle {
  readonly port: number;
  readonly state: LocalState;
  readonly close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function parseBody(raw: string): unknown {
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function onRequest(
  req: IncomingMessage,
  res: ServerResponse,
  catalog: readonly LocalCatalogProblem[],
  state: LocalState,
): Promise<void> {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const raw = await readBody(req);
  const result = handleLocalRequest(
    { method: req.method ?? "GET", path: url.pathname, query, body: parseBody(raw) },
    { catalog, state, now: Date.now() },
  );
  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(JSON.stringify(result.body));
}

/** local Participant API を起動する。 port=0 で OS 割当 (= test で衝突しない)。 */
export function startLocalApi(
  port: number,
  catalog: readonly LocalCatalogProblem[],
  teamName?: string,
): Promise<LocalServerHandle> {
  const state = createLocalState(teamName);
  const server: Server = createServer((req, res) => {
    void onRequest(req, res, catalog, state).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
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
