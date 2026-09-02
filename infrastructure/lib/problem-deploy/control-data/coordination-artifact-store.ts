import type {
  CoordinationArtifactBody,
  CoordinationArtifactRef,
} from "./domain/coordination-artifact.js";
import type { CoordinationStateScope } from "./domain/coordination-scope.js";

/**
 * [Issue #3152] The platform's artifact store seam.
 *
 * Deliberately not a method on `DeploymentsRepository`. That port is the
 * control-data aggregate — rows in DynamoDB or SQL, chosen by
 * `CONTROL_DATA_BACKEND` — and artifacts are neither: they are objects, they
 * are the same objects on both control-data backends, and the whole point of
 * this issue is that they stop living in that row. Folding them in would tie
 * a storage decision that has nothing to do with the backend choice to the
 * backend choice.
 */

export type CoordinationArtifactPutOutcome =
  | { readonly kind: "stored"; readonly ref: CoordinationArtifactRef }
  /**
   * The scope was deleted while this body was being written, so the write was
   * withdrawn. Nothing is left behind under the prefix.
   */
  | { readonly kind: "scope_deleted" };

export interface CoordinationArtifactFetch {
  readonly ref: CoordinationArtifactRef;
  readonly content: Uint8Array;
}

export interface CoordinationArtifactStore {
  /**
   * Stores one body and issues its reference.
   *
   * Returns `scope_deleted` rather than throwing when the scope was torn down
   * underneath the write: from the caller's side that is an ordinary outcome of
   * a match ending, not an error, and it must be distinguishable from a storage
   * failure so a participant is not told their submission failed for a reason
   * that would be worth retrying.
   */
  put(
    scope: CoordinationStateScope,
    body: CoordinationArtifactBody,
  ): Promise<CoordinationArtifactPutOutcome>;

  /** Reads one body back, or `undefined` when there is no such artifact. */
  get(
    scope: CoordinationStateScope,
    artifactId: string,
  ): Promise<CoordinationArtifactFetch | undefined>;

  /**
   * Removes one artifact.
   *
   * Used to withdraw a body whose operation was then rejected — the state never
   * referenced it, so leaving it would be an object nothing can reach and
   * nothing will clean up before the bucket's own expiry.
   */
  remove(scope: CoordinationStateScope, artifactId: string): Promise<void>;

  /**
   * Removes every artifact under a scope and leaves the tombstone that stops an
   * in-flight write from re-creating one. Returns how many objects it removed.
   *
   * Idempotent, like every other deletion primitive in this area: a retried or
   * half-finished teardown has to converge rather than error.
   */
  deleteScope(scope: CoordinationStateScope): Promise<number>;
}

/**
 * The store a deployment gets when no artifact bucket is configured.
 *
 * It refuses writes loudly instead of accepting and discarding them. A store
 * that silently dropped submissions would produce exactly the failure this
 * repository's contract forbids: state referencing artifacts that were never
 * stored, discovered only when a participant tried to fetch one mid-match.
 *
 * Reads and deletions are honest no-ops rather than errors: there is nothing
 * stored, so there is nothing to return and nothing to remove, and making
 * teardown fail over a bucket that was never configured would block a teardown
 * for no gain.
 */
export class UnconfiguredCoordinationArtifactStore implements CoordinationArtifactStore {
  put(): Promise<CoordinationArtifactPutOutcome> {
    return Promise.reject(
      new Error(
        "No coordination artifact bucket is configured (COORDINATION_ARTIFACT_BUCKET); refusing to accept an artifact the platform cannot store.",
      ),
    );
  }

  get(): Promise<CoordinationArtifactFetch | undefined> {
    return Promise.resolve(undefined);
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  deleteScope(): Promise<number> {
    return Promise.resolve(0);
  }
}
