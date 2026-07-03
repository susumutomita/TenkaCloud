import { scanLinesByRegex } from "../scan-lines.ts";
import type { Rule } from "../types.ts";

/**
 * Issue #986 / SOLID enforcement: Lambda handler routing layer
 * (= infrastructure/lib/<...>/handlers/<name>/index.ts) MUST NOT directly
 * import "@aws-sdk/client-*" / "@aws-sdk/lib-*".
 *
 * Rationale (Dependency Inversion Principle / Layered architecture):
 *   index.ts should be HTTP routing only.
 *   Business rule + SDK calls go to a separate service / repository module.
 *
 *   Expected shape:
 *     handlers/<name>/index.ts            — Hono routes (parse, validate, dispatch)
 *       -> handlers/<name>/<service>.ts   — business rule (existing deploy.ts, list.ts, ...)
 *         -> handlers/shared/<repo>.ts    — SDK adapter (cfn-status.ts, external-id-store.ts)
 *
 * Direct SDK import from index.ts couples HTTP context with AWS API context,
 * forces tests to mock both Hono and SDK, and duplicates DDB Put / etc logic
 * across multiple handler index.ts files (DRY violation).
 *
 * Existing violations are tolerated via the baseline file. Only newly added
 * SDK imports in handler index.ts are blocked, to ratchet quality upward.
 *
 * Scope: infrastructure/lib/**\/handlers/**\/index.ts (Hono routing entry).
 *
 * Exceptions:
 *   - shared.ts and other non-index files (service / repository layer may call SDK)
 *   - participant-handler/sso.ts and similar non-index files
 */

const SDK_IMPORT_RE = /from\s+["']@aws-sdk\/(client-|lib-)/;

function shouldInspect(path: string): boolean {
  if (!path.startsWith("infrastructure/lib/")) return false;
  if (!path.includes("/handlers/")) return false;
  if (!path.endsWith("/index.ts")) return false;
  return true;
}

const SDK_PACKAGE_RE = /@aws-sdk\/(client-[a-z-]+|lib-[a-z-]+)/;

export const handlerNoDirectSdkImport: Rule = {
  id: "handler-no-direct-sdk-import",
  severity: "warning",
  check(ctx) {
    return scanLinesByRegex(ctx, {
      ruleId: "handler-no-direct-sdk-import",
      severity: "warning",
      shouldInspect,
      lineRegex: SDK_IMPORT_RE,
      buildFinding: ({ line }) => {
        const pkg = line.match(SDK_PACKAGE_RE)?.[0] ?? "@aws-sdk/?";
        return {
          match: pkg,
          message:
            "Handler routing layer is importing an AWS SDK client (" +
            pkg +
            ") directly. This couples HTTP routing with infrastructure concerns.",
          recommendation:
            "Move SDK calls into a service / repository module. Keep index.ts as routes only. " +
            "See Issue #986 Phase B for the layered architecture pattern.",
        };
      },
    });
  },
};
