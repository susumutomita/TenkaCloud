/**
 * [Composite Runtime / Issue #2069] Lossless, target-namespaced output view for a
 * composite parent.
 *
 * `collectCompositeOutputs` reads a parent's target rows through the #2061
 * repository (GSI3, ordinal order) and assembles a stable map of
 * `{ [targetId]: { [outputKey]: value } }` for internal scoring / later API work:
 *   - only COMPLETE targets are included; a non-COMPLETE target is omitted,
 *   - a COMPLETE target with no outputs yields an empty object (never dropped),
 *   - output names may collide across targets — `targetId` namespaces them, so no
 *     target output is ever flattened into the parent namespace,
 *   - declaration (ordinal) order is preserved in iteration.
 *
 * Existing single-provider `stackOutputs` storage + parsing are untouched: each
 * target row is parsed with the existing {@link parseStackOutputs} rules. Because
 * that parser is fail-safe, a target whose `stackOutputs` is present but is not
 * valid JSON is detected separately and raised as a typed
 * {@link CompositeOutputsError} (parent + target identity) rather than silently
 * returning partial data. This module only transports existing outputs — it adds
 * no secrets — and has no cloud provider SDK dependency.
 */

import { parseStackOutputs } from "../shared/cfn-status.js";
import {
  type CompositeDeploymentRepositoryDeps,
  listCompositeTargets,
} from "./composite-repository.js";

/** `{ [targetId]: { [outputKey]: value } }` — never flattened across targets. */
export type CompositeOutputs = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Raised when a target's persisted outputs cannot be parsed. */
export class CompositeOutputsError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    public readonly targetId: string,
    reason: string,
  ) {
    super(`composite outputs for target ${targetId} under parent ${parentDeploymentId}: ${reason}`);
    this.name = "CompositeOutputsError";
  }
}

/** True when a `stackOutputs` string is present but not parseable JSON. */
function isMalformedOutputJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/**
 * Assemble the target-namespaced output view for a composite parent. Throws
 * {@link CompositeOutputsError} on a malformed target output (no partial result).
 */
export async function collectCompositeOutputs(
  deps: CompositeDeploymentRepositoryDeps,
  parentDeploymentId: string,
): Promise<CompositeOutputs> {
  const targets = [...(await listCompositeTargets(deps, parentDeploymentId))].sort(
    (a, b) => a.targetOrdinal - b.targetOrdinal,
  );

  const result: Record<string, Record<string, string>> = {};
  for (const target of targets) {
    if (target.status !== "COMPLETE") continue; // non-complete targets omitted
    const raw = target.stackOutputs;
    if (raw && isMalformedOutputJson(raw)) {
      throw new CompositeOutputsError(parentDeploymentId, target.targetId, "malformed output JSON");
    }
    // parseStackOutputs returns {} for absent/empty outputs — a COMPLETE target
    // with no outputs is kept as an empty object, never dropped.
    result[target.targetId] = parseStackOutputs(raw);
  }
  return result;
}
