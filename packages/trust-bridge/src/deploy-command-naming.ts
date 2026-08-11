/**
 * Issue #2555: sign-side mirrors of the frozen deploy-detail
 * naming derivations.
 *
 * The authoritative implementations live in the platform's deploy handler
 * (`infrastructure/lib/problem-deploy/handlers/deploy-handler/naming.ts`):
 * `teamSlug`, `namePrefix`, and the destroy-side `stackName` are all derived
 * with `slugify` / `buildStackPrefix`. The Always-On control-plane Worker now
 * publishes the frozen `tenkacloud.deploy` event itself (OIDC command seam),
 * so it must derive those fields with byte-identical results — a drifted slug
 * would orphan the deployed stack from its destroy command.
 *
 * Drift protection: `infrastructure/test/problem-deploy/
 * deploy-command-naming-parity.test.ts` pins these mirrors against the
 * authoritative helpers with shared input vectors — change them only together.
 */

const SLUG_NON_ALPHANUM = /[^A-Za-z0-9]+/g;

function trimBoundaryDashes(input: string): string {
  let start = 0;
  while (input[start] === "-") start += 1;

  let end = input.length;
  while (end > start && input[end - 1] === "-") end -= 1;

  return input.slice(start, end);
}

/** Mirror of the deploy handler's `slugify` (lowercase, dash-joined, max 40). */
export function deploySlugify(input: string): string {
  const sanitized = input.toLowerCase().replace(SLUG_NON_ALPHANUM, "-");
  return trimBoundaryDashes(sanitized).slice(0, 40);
}

/** Mirror of the deploy handler's `buildStackPrefix` (`tc-{problem}-{team}`). */
export function deployStackPrefix(problemId: string, teamName: string): string {
  return `tc-${deploySlugify(problemId)}-${deploySlugify(teamName)}`;
}

/**
 * Shared input vectors for the naming mirrors. The trust-bridge unit test and
 * the infrastructure parity test iterate these IDENTICAL vectors, so a vector
 * added in one place is exercised against both the mirror and the
 * authoritative implementation.
 */
export const DEPLOY_NAMING_VECTORS: readonly (readonly [string, string])[] = [
  ["hello-world", "Team Alpha"],
  ["wp-exposed-backup", "チーム 天下"],
  ["a", "  spaced   out  "],
  ["UPPER-Case-Problem", "MiXeD_case+team"],
  ["x".repeat(80), "y".repeat(80)],
  ["dots.and.dashes-", "-leading-and-trailing-"],
];
