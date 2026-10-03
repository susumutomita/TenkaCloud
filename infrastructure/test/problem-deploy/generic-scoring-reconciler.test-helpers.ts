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

export interface SentCommand {
  readonly constructor: { readonly name: string };
  readonly input: {
    readonly Key?: { readonly PK?: string };
    readonly ConsistentRead?: boolean;
    readonly ConditionExpression?: string;
    readonly ExpressionAttributeValues?: Record<string, unknown>;
  };
}

/**
 * [Issue #3261] Answers the reconciler's strongly consistent base-row re-reads
 * (`GetCommand`, `PK = DEPLOYMENT#<jobId>`) from `baseRows` (keyed by jobId; an
 * absent key models a row a force redeploy already deleted). Every other
 * command falls through to `other`.
 */
export function routeDeploymentGets(
  ddbSend: ReturnType<typeof vi.fn>,
  baseRows: Readonly<Record<string, Record<string, unknown>>>,
  other: (cmd: SentCommand) => unknown = () => ({}),
): void {
  ddbSend.mockImplementation(async (cmd: SentCommand) => {
    if (cmd.constructor.name !== "GetCommand") return other(cmd);
    const jobId = String(cmd.input.Key?.PK ?? "").replace(/^DEPLOYMENT#/, "");
    const item = baseRows[jobId];
    return item ? { Item: { PK: `DEPLOYMENT#${jobId}`, SK: "META", jobId, ...item } } : {};
  });
}

/** Inputs of the commands of one kind (e.g. `GetCommand`) the reconciler sent, in call order. */
export function sentInputs(
  ddbSend: ReturnType<typeof vi.fn>,
  commandName: string,
): SentCommand["input"][] {
  return ddbSend.mock.calls
    .map((call) => call[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === commandName)
    .map((cmd) => cmd.input);
}
