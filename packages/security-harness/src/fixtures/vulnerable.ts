/**
 * Phase 1 conformance fixture — BASELINE (vulnerable). See ./shared.ts for the repository-boundary
 * note: this is a throwaway target for testing this package's own contracts, not a Challenge
 * catalog problem.
 *
 * `GET /documents/:id` returns the document to ANY caller holding a valid token, regardless of
 * ownership — the canonical IDOR this whole slice exercises. `GET /documents/mine` and
 * `POST /documents` (routed by ./shared.ts, identical across every variant) are the declared
 * normal functionality the golden tests check.
 */

import type { Server } from "node:http";
import { digestOfOwnSource } from "../digest.js";
import { createDocumentsServer } from "./shared.js";

export const DIGEST = digestOfOwnSource(import.meta.url);

export function createServer(): Server {
  // VULNERABILITY: no ownership check at all — any authenticated caller can read any document.
  return createDocumentsServer((doc) => ({
    status: 200,
    body: { id: doc.id, content: doc.content },
  }));
}
