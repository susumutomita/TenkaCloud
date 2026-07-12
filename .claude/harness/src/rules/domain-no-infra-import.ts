import { scanLinesByRegex } from "../scan-lines.ts";
import type { Rule } from "../types.ts";

/**
 * Issue #2527 Slice 7: the control-data domain layer must stay pure.
 *
 * The #2527 dependency contract is one-directional:
 *
 *   domain records / capability ports
 *     -> application use cases / handlers
 *       -> adapters (DynamoDB / SQL / mirror)
 *         -> composition roots (Lambda / CDK / CLI)
 *
 * Adapters may depend on the domain; the domain must never depend on handlers,
 * adapters, or the AWS SDK. Before Slice 1 the domain types were derived from
 * handler item shapes (`Omit<...>` over physical DDB items), which meant a storage
 * change rippled upward through every layer — this rule keeps that inversion from
 * coming back.
 *
 * Scope: infrastructure/lib/problem-deploy/control-data/domain/**. Banned import
 * specifiers:
 *   - "@aws-sdk/..."           — AWS SDK (infrastructure concern)
 *   - "aws-cdk-lib..." / "constructs" — CDK (composition concern)
 *   - any "../..."             — everything above domain/ is adapter / factory /
 *                                handler territory; the domain is the bottom layer
 *   - anything containing "/handlers/" — handler layer via any route
 *
 * Allowed: "./" siblings inside domain/ and pure workspace packages
 * (e.g. @tenkacloud/saml-utils).
 */

const DOMAIN_PREFIX = "infrastructure/lib/problem-deploy/control-data/domain/";

const BANNED_SPECIFIER_RE =
  /(?:^\s*import\s+|from\s+|require\()\s*["'](@aws-sdk\/[^"']*|aws-cdk-lib[^"']*|constructs|\.\.\/[^"']*|[^"']*\/handlers\/[^"']*)["']/;

function shouldInspect(path: string): boolean {
  return path.startsWith(DOMAIN_PREFIX) && /\.tsx?$/.test(path);
}

export const domainNoInfraImport: Rule = {
  id: "domain-no-infra-import",
  severity: "error",
  check(ctx) {
    return scanLinesByRegex(ctx, {
      ruleId: "domain-no-infra-import",
      severity: "error",
      shouldInspect,
      lineRegex: BANNED_SPECIFIER_RE,
      stripComments: true,
      buildFinding: ({ line }) => {
        const specifier = line.match(BANNED_SPECIFIER_RE)?.[1] ?? "?";
        return {
          match: specifier,
          message:
            'control-data domain module is importing "' +
            specifier +
            '" — the domain layer must not depend on handlers, adapters, or the AWS SDK ' +
            "(#2527 dependency direction).",
          recommendation:
            "Keep domain records / ports self-contained. Move the storage- or handler-facing " +
            "logic into the adapter that needs it, and let the adapter import the domain " +
            "(never the reverse). See #2527 「目標とする境界」.",
        };
      },
    });
  },
};
