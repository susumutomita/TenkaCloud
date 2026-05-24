/**
 * [ADR-023 / Issue #1268] Runtime normalization for the deploy worker side.
 *
 * Mirrors `scripts/problem-cli/problem-loader.ts#normalizeRuntime` but lives
 * inside the Lambda bundle. The Lambda must not import from `scripts/` (=
 * separate workspace, separate tsconfig, different bundling target), so the
 * normalization rules are duplicated by design.
 *
 * Rules (kept in lock-step with `validate-problems` / `problem-cli`):
 *   1. An explicit `runtime` block on `metadata.json` wins. It must declare
 *      provider / engine / entry all as strings, otherwise the input is
 *      malformed and we return `undefined` (caller throws).
 *   2. Legacy problems (only `cfnTemplate` declared) are normalized to
 *      `aws / cloudformation / <cfnTemplate>` — this is the back-compat path.
 *   3. The very last fallback is `aws / cloudformation / template.yaml` so
 *      future scaffolding never blows up before the validator runs.
 *
 * Consistency between `runtime.entry` and `cfnTemplate` is NOT checked here —
 * that lives in `scripts/problem-cli/validate.ts` and runs at PR time. By
 * deploy time, validate-problems has already passed, so the deploy handler
 * trusts the descriptor as-is.
 */

import type { ProblemRuntime } from "./adapter.js";

export const EXECUTABLE_PROVIDER = "aws" as const;
export const EXECUTABLE_ENGINE = "cloudformation" as const;

/**
 * Loose metadata shape. We accept `Record<string, unknown>` because the
 * Lambda parses metadata coming from EventBridge / catalog payloads that have
 * already been JSON.parsed — we cannot assume a Zod schema upfront here.
 */
export type RuntimeMetadataInput = {
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
};

/**
 * Normalize a problem's runtime descriptor. Returns `undefined` only when an
 * explicit `runtime` block is present but malformed (= missing provider /
 * engine / entry, or wrong types). Callers should treat `undefined` as a
 * loud failure (the input is unparseable, not a missing default).
 */
export function normalizeRuntime(meta: RuntimeMetadataInput): ProblemRuntime | undefined {
  const runtime = meta.runtime as Record<string, unknown> | undefined;
  if (runtime !== undefined && runtime !== null) {
    if (
      typeof runtime.provider !== "string" ||
      typeof runtime.engine !== "string" ||
      typeof runtime.entry !== "string"
    ) {
      return undefined;
    }
    return {
      provider: runtime.provider,
      engine: runtime.engine,
      entry: runtime.entry,
    };
  }
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : "template.yaml";
  return {
    provider: EXECUTABLE_PROVIDER,
    engine: EXECUTABLE_ENGINE,
    entry: cfnTemplate,
  };
}

export function isExecutableRuntime(runtime: ProblemRuntime): boolean {
  return runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE;
}
