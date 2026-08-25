/**
 * A "patch" that fails to build/start at all (Issue #3036 condition 2: "patch build が成功して
 * いること"). This is a real, throwaway conformance fixture for this package's own contracts, not
 * a Challenge catalog problem (see ../fixtures/shared.ts) — `createServer()` throws synchronously,
 * the same way a broken `npm run build` or a crashing entrypoint would prevent a real container
 * from ever reaching readiness. `runPhase1Slice` in ../phase1-slice.ts must observe this failure
 * and evaluate it as `build: "failed"` (→ `inconclusive`, never a silent pass and never an
 * uncaught exception out of the run).
 */

import type { Server } from "node:http";
import { digestOfOwnSource } from "../digest.js";

export const DIGEST = digestOfOwnSource(import.meta.url);

export function createServer(): Server {
  throw new Error("patched-build-failure fixture: the patch target never starts");
}
