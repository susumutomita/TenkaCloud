import { hashLoginKey } from "../../control-data/sql-teams-repository.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { warnDeployTrace } from "../shared/trace-log.js";

/**
 * Issue #2675: why a `GET /portal/me` login resolved to a 401 (an undefined team
 * view). The HTTP response is intentionally identical for every reason — letting a
 * competitor tell "wrong key" apart from "valid key, no deployment yet" would turn
 * the login endpoint into an enumeration oracle. The distinction lives only in a
 * server-side warn log so an operator can triage a login failure from CloudWatch
 * instead of hand-querying the production control-data store — which is exactly what
 * #2672 forced.
 *
 * `lookupTeamByLoginKey` returns undefined in three observable states, all reached
 * only after `buildTeamView` finds no live row:
 *
 * | reason           | condition                                                        |
 * | ---------------- | ---------------------------------------------------------------- |
 * | `no_rows`        | `listByTeamLoginKey` matched 0 rows                              |
 * | `all_deleted`    | rows exist, every one is DELETED / DELETING (operator teardown)  |
 * | `no_live_sample` | rows exist, none live, at least one EXPIRED / AUTO_DELETED (TTL) |
 *
 * `no_rows` folds together three cases this Deployments-only lookup cannot tell
 * apart — a genuinely wrong key, a valid key whose team has no deployment yet, and
 * the #2672-class bug where the row exists but its `login_key_hash` was wiped.
 * Splitting those needs the Teams cross-check owned by #2674; this log stops at
 * `no_rows` and records the key fingerprint so that follow-up stays possible.
 */
export type LoginLookupMissReason = "no_rows" | "all_deleted" | "no_live_sample";

/** Statuses that mean an operator / participant explicitly tore the deployment down. */
const EXPLICITLY_DELETED_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

/**
 * Classify a login lookup miss. Precondition: the caller only invokes this on the
 * undefined (401) branch, i.e. no live row exists — so a non-empty `items` means
 * every row is DELETED_LIKE, and the only question left is whether the team was
 * explicitly torn down or lifecycle-expired.
 */
export function classifyLoginLookupMiss(
  items: readonly Partial<DeploymentItem>[],
): LoginLookupMissReason {
  if (items.length === 0) return "no_rows";
  return items.every((item) =>
    EXPLICITLY_DELETED_STATUSES.has((item.status ?? "PENDING") as DeploymentStatus),
  )
    ? "all_deleted"
    : "no_live_sample";
}

/** SHA-256 hex chars logged for key correlation — never the plaintext bearer. */
const LOGIN_KEY_HASH_PREFIX_LEN = 8;

/**
 * A short, non-reversible fingerprint of the team login key. Uses the codebase's
 * canonical {@link hashLoginKey} (the same SHA-256 stored in `login_key_hash`), so
 * in the SQL backend the prefix correlates with the stored row; in every backend it
 * correlates repeated failures from one key without ever exposing the plaintext.
 */
export function loginKeyHashPrefix(teamLoginKey: string): string {
  return hashLoginKey(teamLoginKey).slice(0, LOGIN_KEY_HASH_PREFIX_LEN);
}

/**
 * Emit the structured 401 diagnostic. Callers must invoke this on the undefined
 * (401) branch only. Never logs the plaintext key — only the reason, the hash
 * prefix, and the row count.
 */
export function warnLoginUnauthorized(
  teamLoginKey: string,
  items: readonly Partial<DeploymentItem>[],
): void {
  warnDeployTrace("portal.login.unauthorized", {
    reason: classifyLoginLookupMiss(items),
    keyHashPrefix: loginKeyHashPrefix(teamLoginKey),
    rowCount: items.length,
  });
}
