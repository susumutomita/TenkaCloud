/**
 * Issue #2293: sign-side mirrors of the frozen deploy-detail
 * identifier shapes.
 *
 * The authoritative definitions live in the platform's frozen EventBridge detail
 * schema (`infrastructure/lib/problem-deploy/handlers/shared/events.ts`,
 * `DeployCreate/DeleteRequestedDetailSchema`). The Always-On control-plane
 * Worker validates organizer commands against these BEFORE the OIDC exchange,
 * so a command downstream would reject fails fast at the edge instead of
 * spending an STS round trip.
 *
 * Drift protection: `infrastructure/test/problem-deploy/
 * deploy-command-patterns-parity.test.ts` pins these against the authoritative
 * schema with shared accept/reject vectors — change them only together.
 */

/** Problem slug: lowercase alphanumeric + inner hyphens, 1..64 chars. */
export const DEPLOY_PROBLEM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** AWS account id: exactly 12 digits. */
export const DEPLOY_AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

/** AWS region name, e.g. `ap-northeast-1`. */
export const DEPLOY_AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/;

/**
 * Shared accept/reject vectors for the patterns above. The trust-bridge unit
 * test and the infrastructure schema-parity test iterate these IDENTICAL
 * vectors, so a vector added in one place is exercised against both the mirror
 * pattern and the authoritative frozen schema.
 */
export const DEPLOY_COMMAND_PATTERN_VECTORS = {
  problemId: {
    accept: ["a", "hello-world", "a1-b2-c3", "x".repeat(64)],
    reject: ["", "Hello-World", "hello_world", "-leading", "trailing-", "x".repeat(65)],
  },
  awsAccountId: {
    accept: ["111111111111"],
    reject: ["", "1234", "1111111111111", "11111111111a"],
  },
  region: {
    accept: ["ap-northeast-1", "us-east-1", "eu-west-2"],
    reject: ["", "AP-NORTHEAST-1", "us-east", "useast1", "us-east-1a"],
  },
} as const;
