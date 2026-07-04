/**
 * ADR-049 Phase 4 (Issue #2293) — sign-side mirrors of the FROZEN deploy-detail
 * identifier shapes.
 *
 * The authoritative definitions live in the platform's frozen EventBridge detail
 * schema (`infrastructure/lib/problem-deploy/handlers/shared/events.ts`,
 * `DeployCreate/DeleteRequestedDetailSchema`). A control-plane host (the Workers
 * always-on control plane) validates organizer commands against these BEFORE
 * minting and signing an intent, so a command the ingress would reject fails
 * fast client-side instead of consuming a signature + nonce.
 *
 * Drift protection: `infrastructure/test/intent-ingress/
 * deploy-command-patterns-parity.test.ts` pins these against the authoritative
 * schema with shared accept/reject vectors — change them only together.
 */

/** Problem slug: lowercase alphanumeric + inner hyphens, 1..64 chars. */
export const DEPLOY_PROBLEM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** AWS account id: exactly 12 digits. */
export const DEPLOY_AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

/** AWS region name, e.g. `ap-northeast-1`. */
export const DEPLOY_AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/;
