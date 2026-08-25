/**
 * Phase 1 conformance fixture — PATCH (correct). See ./shared.ts for the repository-boundary note.
 *
 * `GET /documents/:id` now checks ownership and returns 403 on a mismatch. This is the "real fix"
 * variant the orchestrator should certify as `verified-fixed`: golden tests still pass, the
 * original witness (doc-b1) is blocked, and a fresh re-attack (doc-b2) finds nothing either.
 */

import type { Server } from "node:http";
import { digestOfOwnSource } from "../digest.js";
import { createDocumentsServer } from "./shared.js";

export const DIGEST = digestOfOwnSource(import.meta.url);

export function createServer(): Server {
  // FIX: ownership is checked for every document id, not just the one the reporter used.
  return createDocumentsServer((doc, owner) =>
    doc.owner === owner
      ? { status: 200, body: { id: doc.id, content: doc.content } }
      : { status: 403, body: { error: "forbidden" } },
  );
}
