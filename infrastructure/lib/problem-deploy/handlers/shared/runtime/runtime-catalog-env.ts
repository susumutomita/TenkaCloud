/**
 * [ADR-023 / #2054] Decode the `BATTLE_PROBLEMS_RUNTIMES` env into a per-problemId
 * runtime resolver for the deploy handler.
 *
 * The env is baked at synth from each non-aws problem's normalized
 * `metadata.runtime` (`{ problemId: { provider, engine, entry } }` JSON). A
 * problemId absent from the map resolves to `undefined`, so the deploy worker
 * assumes `aws/cloudformation` (= the legacy default — every CFn problem). A
 * present entry (e.g. a container's `docker/compose`) is returned so
 * `selectAdapter` rejects it with `RuntimeNotSupportedError` BEFORE any cloud
 * mutation, preventing a local-only problem from being deployed to the cloud.
 */

import type { ProblemRuntime } from "./adapter.js";

export function parseProblemRuntimes(raw: string | undefined): Record<string, ProblemRuntime> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[parseProblemRuntimes] BATTLE_PROBLEMS_RUNTIMES parse failed (${(err as Error).message}). ` +
        "non-aws problems will fall through to the aws/cloudformation default (deploy then fails at template resolution).",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const runtimes: Record<string, ProblemRuntime> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (
      typeof r.provider === "string" &&
      typeof r.engine === "string" &&
      typeof r.entry === "string"
    ) {
      runtimes[id] = { provider: r.provider, engine: r.engine, entry: r.entry };
    }
  }
  return runtimes;
}

/** Build the `resolveProblemRuntime` resolver wired into the deploy handler. */
export function makeProblemRuntimeResolver(
  raw: string | undefined,
): (problemId: string) => ProblemRuntime | undefined {
  const runtimes = parseProblemRuntimes(raw);
  return (problemId) => runtimes[problemId];
}
