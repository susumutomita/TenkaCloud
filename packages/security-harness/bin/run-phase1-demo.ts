#!/usr/bin/env bun
/**
 * Issue #3036 Phase 1 — the one documented command the issue's "First E2E" acceptance criteria
 * ask for: "一つの documented command または API で開始から report 生成まで完走できる".
 *
 * Runs the full deterministic vertical slice against each of the three patch variants declared
 * in `../src/fixtures`, and prints one JSON report per run to stdout — real HTTP evidence, not a
 * hand-written example.
 *
 * Usage: bun run bin/run-phase1-demo.ts   (or: make security-harness-demo from the repo root)
 */

import { runPhase1Slice } from "../src/phase1-slice.js";

const RUNS: readonly {
  readonly label: string;
  readonly patchVariant: Parameters<typeof runPhase1Slice>[0]["patchVariant"];
}[] = [
  { label: "correct fix", patchVariant: "patched-correct" },
  { label: "incomplete fix (id denylist only)", patchVariant: "patched-denylist-only" },
  { label: "fake fix (endpoint removed)", patchVariant: "patched-endpoint-removed" },
];

async function main(): Promise<void> {
  // A fixed clock keeps the printed report byte-for-byte reproducible across runs.
  const fixedNow = (): string => "2026-01-01T00:00:00.000Z";

  for (const run of RUNS) {
    const result = await runPhase1Slice({
      runId: `demo-${run.patchVariant}`,
      baselineVariant: "vulnerable",
      patchVariant: run.patchVariant,
      now: fixedNow,
    });
    process.stdout.write(`\n=== ${run.label} (patch: ${run.patchVariant}) ===\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  // A run whose declared "vulnerable" baseline is not actually reproducible — the run must land
  // on INCONCLUSIVE, never a participant win or loss.
  const inconclusive = await runPhase1Slice({
    runId: "demo-baseline-not-reproducible",
    baselineVariant: "patched-correct",
    patchVariant: "patched-correct",
    now: (): string => "2026-01-01T00:00:00.000Z",
  });
  process.stdout.write("\n=== baseline not reproducible (must be INCONCLUSIVE, not a fail) ===\n");
  process.stdout.write(`${JSON.stringify(inconclusive, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
