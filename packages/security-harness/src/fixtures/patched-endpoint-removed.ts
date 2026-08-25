/**
 * Phase 1 conformance fixture — PATCH (fake fix: endpoint removed). See ./shared.ts for the
 * repository-boundary note.
 *
 * Mirrors the issue's other named fake-fix pattern: "endpoint 全体を 404 にする". `GET
 * /documents/:id` now 404s unconditionally, including for a caller fetching their own document —
 * so the golden "own document" behavior tests must fail here, and `evaluatePatchVerdict` must
 * resolve this to `regressed`, not `verified-fixed`, regardless of what the witness replay says.
 */

import type { Server } from "node:http";
import { digestOfOwnSource } from "../digest.js";
import { createDocumentsServer } from "./shared.js";

export const DIGEST = digestOfOwnSource(import.meta.url);

export function createServer(): Server {
  // FAKE FIX: the single-document read decision always reports "not found", silencing the
  // exploit — and, just as much, the legitimate case the golden tests check.
  return createDocumentsServer(() => ({ status: 404, body: { error: "not-found" } }));
}
