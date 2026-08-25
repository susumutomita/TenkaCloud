/**
 * Phase 1 conformance fixture — PATCH (incomplete: id-denylist only). See ./shared.ts for the
 * repository-boundary note.
 *
 * Mirrors the exact "fake fix" the issue calls out: "test fixture ID だけを denylist する". This
 * variant hardcodes a 403 for `doc-b1` — the exact id the original/canonical witness targets —
 * but every OTHER id is still served with no ownership check. The original witness replay is
 * correctly blocked, but a fresh re-attack against a different id (`doc-b2`) still lands, so
 * `evaluatePatchVerdict` must resolve this to `still-vulnerable`, not `verified-fixed`.
 */

import type { Server } from "node:http";
import { digestOfOwnSource } from "../digest.js";
import { createDocumentsServer } from "./shared.js";

export const DIGEST = digestOfOwnSource(import.meta.url);

/** The one id this "fix" happens to have been tested against and denylisted — everything else stays open. */
const DENYLISTED_ID = "doc-b1";

export function createServer(): Server {
  return createDocumentsServer((doc, owner) => {
    // INCOMPLETE FIX: only the one id the reporter used is checked. Every other document is
    // still returned to anyone with a valid token.
    if (doc.id === DENYLISTED_ID && doc.owner !== owner) {
      return { status: 403, body: { error: "forbidden" } };
    }
    return { status: 200, body: { id: doc.id, content: doc.content } };
  });
}
