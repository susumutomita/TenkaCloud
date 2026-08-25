/**
 * Shared fixture plumbing for the Phase 1 IDOR conformance target (Issue #3036).
 *
 * IMPORTANT — repository boundary: this is a throwaway, test-only target that exists ONLY to
 * exercise this package's orchestrator/witness/verdict contracts end to end. It is NOT the
 * "official" intentionally-vulnerable Challenge problem the issue's "First E2E" section assigns
 * to `TenkaCloudChallenge` (see AGENTS.md "Repository responsibility" / repository boundary) —
 * that is separate, out-of-scope, follow-up work with its own hidden-witness and spoiler
 * requirements. Nothing here is participant-visible or reachable from any product surface; it is
 * imported only by this package's own tests and `bin/run-phase1-demo.ts`.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

interface Doc {
  readonly id: string;
  readonly owner: string;
  readonly content: string;
}

/** A fresh, mutable copy per server instance — never shared module state across "fresh environment" launches. */
function seedDocs(): Doc[] {
  return [
    { id: "doc-a1", owner: "userA", content: "Alice private note A1" },
    { id: "doc-b1", owner: "userB", content: "Bob private note B1" },
    // doc-b2 exists from the start but is never targeted by the baseline/original witness — only
    // the fresh re-attack witness targets it, so it is the seam that catches an id-denylist patch.
    { id: "doc-b2", owner: "userB", content: "Bob private note B2" },
  ];
}

const TOKENS: Readonly<Record<string, string>> = {
  "token-a": "userA",
  "token-b": "userB",
};

function ownerForToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  return TOKENS[authHeader];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** What a `GET /documents/:id` route decides once a document and the caller's owner id are known — the ONLY thing that differs between the baseline and each patch variant. */
export type GetByIdHandler = (
  doc: Doc,
  owner: string,
) => { readonly status: number; readonly body: unknown };

function handleListMine(
  res: ServerResponse,
  docs: readonly Doc[],
  owner: string | undefined,
): void {
  if (!owner) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  sendJson(res, 200, { docs: docs.filter((d) => d.owner === owner) });
}

function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  docs: Doc[],
  owner: string | undefined,
): void {
  if (!owner) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  readRequestBody(req)
    .then((raw) => {
      const parsed = raw.length > 0 ? (JSON.parse(raw) as { content?: unknown }) : {};
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const created: Doc = { id: `doc-${owner}-${docs.length + 1}`, owner, content };
      docs.push(created);
      sendJson(res, 201, created);
    })
    .catch(() => sendJson(res, 400, { error: "bad-request" }));
}

function handleGetById(
  res: ServerResponse,
  docs: readonly Doc[],
  owner: string | undefined,
  id: string,
  getById: GetByIdHandler,
): void {
  if (!owner) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const doc = docs.find((d) => d.id === id);
  if (!doc) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  const decision = getById(doc, owner);
  sendJson(res, decision.status, decision.body);
}

/**
 * The routing every fixture variant shares: `GET /documents/mine` and `POST /documents` are
 * declared normal functionality (identical across every variant, checked by the golden tests);
 * `GET /documents/:id` is delegated to `getById`, which is the one seam that distinguishes the
 * vulnerable baseline from each patch variant. Centralizing this here means a variant file is
 * exactly the ownership decision it makes, not a second copy of the routing.
 */
export function createDocumentsServer(getById: GetByIdHandler): Server {
  const docs: Doc[] = seedDocs();

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const owner = ownerForToken(req.headers.authorization);

    if (req.method === "GET" && url.pathname === "/documents/mine") {
      return handleListMine(res, docs, owner);
    }
    if (req.method === "POST" && url.pathname === "/documents") {
      return handleCreate(req, res, docs, owner);
    }
    const match = /^\/documents\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      return handleGetById(res, docs, owner, match[1], getById);
    }
    sendJson(res, 404, { error: "not-found" });
  });
}
