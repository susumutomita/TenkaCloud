import { scanLinesByRegex } from "../scan-lines.ts";
import type { Rule } from "../types.ts";

/**
 * Issue #2527 Slice 7 (promised in PR-2572): `createDefaultControlDataRuntime()` is the
 * control-data composition-root factory — process.env + a real SSMClient + the real
 * libSQL client. Slice 4 deleted the module singleton so that every Lambda entrypoint
 * composes exactly one runtime and injects it down through its handler family's shared
 * resources; a handler/service module quietly composing its own runtime would
 * re-introduce the hidden-global problem (untestable seams, duplicate cold-start
 * caches) that #2527 problem 4 removed.
 *
 * Allowed composition sites:
 *   - Lambda entrypoints: infrastructure/lib/**\/handlers/<name>/index.ts and the
 *     intent-ingress shape infrastructure/lib/**\/handler/index.ts
 *   - handlers/shared/audit-log.ts — the one documented self-composed default (the
 *     fire-and-forget audit side-channel keeps its 12 call sites signature-free)
 *   - control-data/runtime-repositories.ts — the factory's own definition
 *
 * Everywhere else under infrastructure/lib/**, referencing the factory (import or
 * call) is an error: take a `runtime: ControlDataRuntime` through your deps instead.
 * JSDoc mentions are fine (comments are stripped before matching).
 */

const FACTORY_RE = /\bcreateDefaultControlDataRuntime\b/;

const ENTRYPOINT_RE = /\/(?:handlers\/[^/]+|handler)\/index\.ts$/;

const ALLOWED_FILES = new Set([
  "infrastructure/lib/problem-deploy/handlers/shared/audit-log.ts",
  "infrastructure/lib/problem-deploy/control-data/runtime-repositories.ts",
]);

function shouldInspect(path: string): boolean {
  if (!path.startsWith("infrastructure/lib/")) return false;
  if (!/\.tsx?$/.test(path)) return false;
  if (ENTRYPOINT_RE.test(path)) return false;
  if (ALLOWED_FILES.has(path)) return false;
  return true;
}

export const runtimeCompositionRootOnly: Rule = {
  id: "runtime-composition-root-only",
  severity: "error",
  check(ctx) {
    return scanLinesByRegex(ctx, {
      ruleId: "runtime-composition-root-only",
      severity: "error",
      shouldInspect,
      lineRegex: FACTORY_RE,
      stripComments: true,
      buildFinding: () => ({
        match: "createDefaultControlDataRuntime",
        message:
          "createDefaultControlDataRuntime() may only be composed at a Lambda entrypoint " +
          "(handlers/<name>/index.ts) or the documented audit-log default — this module is " +
          "neither, so it would re-introduce a hidden runtime global (#2527 Slice 4).",
        recommendation:
          "Accept the runtime through your deps (`runtime: ControlDataRuntime`) and let the " +
          "entrypoint inject it. In tests, use makeTestControlDataRuntime() from " +
          "test/problem-deploy/control-data/runtime.test-helpers.ts.",
      }),
    });
  },
};
