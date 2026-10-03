/**
 * [#2054] Decode the `BATTLE_PROBLEMS_RUNTIMES` env into a per-problemId
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

import {
  type CompositeRuntimeDescriptor,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
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

/**
 * [Composite Runtime / Issue #2075] Decode `BATTLE_PROBLEMS_RUNTIMES` into a
 * per-problemId descriptor map that ALSO surfaces composite runtimes.
 *
 * The single-provider {@link parseProblemRuntimes} intentionally keeps only
 * `{provider,engine,entry}` entries (it is the input to `selectAdapter`, which
 * only knows single runtimes). The composite deploy path needs the composite
 * descriptor too, so this parser routes every entry through
 * `normalizeRuntime` — single entries come back identical to the legacy parser,
 * composite entries (`kind:"composite"`) are validated + preserved with their
 * declared target order. A structurally-wrong single entry is dropped, and a
 * malformed composite entry (which makes `normalizeRuntime` throw
 * `RuntimeValidationError`) is dropped with a warning — the parser is fail-safe
 * so one bad baked entry never crashes the deploy Lambda's cold start (mirrors
 * the legacy {@link parseProblemRuntimes} fail-safe).
 */
export function parseProblemRuntimeDescriptors(
  raw: string | undefined,
): Record<string, ProblemRuntimeDescriptor> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[parseProblemRuntimeDescriptors] BATTLE_PROBLEMS_RUNTIMES parse failed (${(err as Error).message}). ` +
        "non-aws problems will fall through to the aws/cloudformation default.",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const descriptors: Record<string, ProblemRuntimeDescriptor> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    // A baked composite entry is `{ kind, targets }`; wrap it as `meta.runtime`
    // so `normalizeRuntime` validates + returns the composite descriptor.
    // A baked single entry is `{ provider, engine, entry }` — same wrapping
    // yields the identical single descriptor.
    try {
      const descriptor = normalizeRuntime({ id, runtime: record });
      if (descriptor) descriptors[id] = descriptor;
    } catch (err) {
      console.warn(
        `[parseProblemRuntimeDescriptors] dropping invalid runtime for ${id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return descriptors;
}

/**
 * [Composite Runtime / Issue #2075] Build the descriptor resolver the deploy
 * route uses to decide between the legacy single-provider path and the composite
 * path. Returns `undefined` for a problemId absent from the baked catalog (=
 * `aws/cloudformation` default — every legacy CFn problem stays on
 * `startDeployment` unchanged).
 */
export function makeProblemRuntimeDescriptorResolver(
  raw: string | undefined,
): (problemId: string) => ProblemRuntimeDescriptor | undefined {
  const descriptors = parseProblemRuntimeDescriptors(raw);
  return (problemId) => descriptors[problemId];
}

/** Narrow a resolved descriptor to a composite one (for the deploy route). */
export function asCompositeDescriptor(
  descriptor: ProblemRuntimeDescriptor | undefined,
): CompositeRuntimeDescriptor | undefined {
  if (descriptor && "kind" in descriptor && descriptor.kind === "composite") {
    return descriptor;
  }
  return undefined;
}
