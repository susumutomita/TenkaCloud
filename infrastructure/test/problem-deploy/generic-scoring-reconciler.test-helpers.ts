import { vi } from "vitest";
import type { ReconcileEventStatusesContext } from "../../lib/problem-deploy/handlers/generic-scoring-handler/event-reconciler";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Shared fixtures / helpers for the `generic-scoring-reconciler` test suite.
 *
 * Split out per #1255 — the original `generic-scoring-reconciler.test.ts` grew
 * past 500 lines / 65 expects. Per-scenario test files (`*-pure-logic`,
 * `*-transitions`, `*-pagination`, `*-stuck-deleting`, `*-errors`) all consume
 * `buildCtx()` from here so the DDB mock wiring stays DRY.
 *
 * Filename ends in `.test-helpers.ts` (NOT `.test.ts`) so vitest's collector
 * does not pick it up as a test file.
 */

export const NOW_ISO = "2026-05-11T00:00:00.000Z";

export function buildCtx(): {
  ctx: ReconcileEventStatusesContext;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const ctx: ReconcileEventStatusesContext = {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: ddbSend } as unknown as ReconcileEventStatusesContext["ddb"],
    eventsTableName: "TestEvents",
    deploymentsTableName: "TestDeployments",
  };
  return { ctx, ddbSend };
}
