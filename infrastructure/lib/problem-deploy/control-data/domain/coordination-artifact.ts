import type { CoordinationStateScope } from "./coordination-scope.js";

/**
 * [Issue #3152] Immutable submission artifacts, held apart from the mutable
 * coordination state row.
 *
 * ## What this separates and why
 *
 * A coordination match's row holds two very different kinds of thing. One is
 * genuinely mutable and small: the score, the phase, the generation, which
 * orders are open. The other is a growing pile of things that are written once
 * and never changed — a PROVE proof, a LEAK artifact, an FHE ciphertext, an MPC
 * transcript. In `ac26-crypto-battle`'s 99-team worst case the second kind is
 * 1081 KB of a 1624 KB row: two thirds of the state is material nothing will
 * ever edit.
 *
 * Keeping that in the row makes every operation pay for it, because the row is
 * read, modified and written whole. Moving it out leaves the state a few
 * hundred KB and gives the size budget (#3151) room it did not have.
 *
 * ## The design is the READ path, not the write path
 *
 * Moving the bytes out is the easy half and on its own it makes things worse.
 * `projectForTeam` returns the public ledger in full on every poll, so a naive
 * split turns one row read into N object reads per participant per poll.
 *
 * So the contract is not "write elsewhere"; it is **the projection carries
 * references, and the body is fetched at the moment a participant acts on it**.
 * That is why {@link CoordinationArtifactRef} carries enough to be useful on
 * its own — id, type, size, digest — and why fetching a body is a separate,
 * explicit request rather than something the projection does implicitly.
 *
 * The operation this matters most for is `ac26-crypto-battle`'s HUNT, which
 * recovers a secret from the share values in the ledger. A projection of
 * metadata alone would break it. A projection of references plus an on-demand
 * fetch does not: the hunter fetches the bodies of the shares they are actually
 * hunting, when they hunt.
 *
 * ## Who owns what
 *
 * The platform owns storage, keys, and lifecycle; the plugin stays a pure state
 * machine that never performs I/O. Bodies arrive alongside an operation, the
 * platform stores them BEFORE dispatch, and the plugin's `applyOp` sees only
 * references — so `applyOp` remains a pure function of `(state, teamId, op)`
 * exactly as it was.
 */

/**
 * What the plugin's state holds in place of an artifact body.
 *
 * Everything here is safe to keep in the state row and to put in a projection:
 * it identifies and describes the body without being it.
 */
export interface CoordinationArtifactRef {
  /** Platform-issued, opaque, unique within a scope. */
  readonly artifactId: string;
  /** Declared media type, echoed back verbatim when the body is fetched. */
  readonly contentType: string;
  /** Size of the stored body in bytes. */
  readonly bytes: number;
  /**
   * SHA-256 of the body, hex.
   *
   * Present so a plugin can bind its state to the exact bytes it accepted. An
   * artifact store that returned different bytes later would be caught by a
   * plugin that checks, and the digest costs nothing to carry.
   */
  readonly digest: string;
  /**
   * When the platform accepted the body (epoch ms).
   *
   * Load-bearing rather than decorative: it is what makes a submission ordered
   * with respect to a scope deletion. See {@link CoordinationArtifactTombstone}.
   */
  readonly writtenAtMs: number;
}

/** A body on its way in, before the platform has issued a reference for it. */
export interface CoordinationArtifactBody {
  readonly contentType: string;
  readonly content: Uint8Array;
}

/**
 * The marker a deleted scope leaves behind.
 *
 * ## Why a marker is needed at all
 *
 * Deleting a scope's artifacts is "list everything under this prefix and remove
 * it", and that races a submission already in flight: the write lands after the
 * listing, and its object is left behind with nothing referencing it — an
 * orphan under a prefix the platform believes it has emptied.
 *
 * The marker closes it from the other side. A write does not have to be ordered
 * against the sweep, only against the marker: after storing its body a writer
 * re-reads the marker, and if the scope was deleted at or after the instant the
 * write began, the writer removes what it just wrote and reports the scope as
 * gone. Whichever order the two operations actually interleave, the object
 * either predates the marker and is swept, or postdates the writer's own check
 * and is withdrawn by the writer.
 *
 * ## Why it carries a time rather than being a bare flag
 *
 * A bare flag would void the prefix permanently, which is right only if a scope
 * is never reused. `deletedAtMs` lets the marker say which generation of
 * submissions it voids, so a scope that legitimately starts over is not
 * poisoned by its own history.
 */
export interface CoordinationArtifactTombstone {
  readonly deletedAtMs: number;
}

/**
 * The largest body the platform will accept for one artifact.
 *
 * 1 MiB is chosen against what these artifacts actually are — proofs,
 * ciphertexts, transcripts — and against the fact that the body travels inside
 * a participant's operation request. It is far above the measured per-entry
 * sizes in `ac26-crypto-battle` (hundreds of bytes) and far below anything that
 * would make a single operation slow to upload or expensive to store.
 *
 * A ceiling exists at all because without one a participant could push
 * unbounded data through an authenticated endpoint, and because the platform
 * would then be unable to say what a match costs to store.
 */
export const COORDINATION_ARTIFACT_MAX_BYTES = 1024 * 1024;

/** How many artifacts one operation may carry. */
export const COORDINATION_ARTIFACT_MAX_PER_OP = 8;

/** The reserved key under which the platform hands references to the plugin. */
export const COORDINATION_ARTIFACT_OP_KEY = "artifacts" as const;

/**
 * Root prefix for every coordination artifact.
 *
 * Everything the platform writes for this feature lives under one prefix so the
 * bucket policy and the IAM grants can name it, and so a bucket shared with
 * anything else could never be reached by this code path.
 */
export const COORDINATION_ARTIFACT_PREFIX = "coordination/";

/** Object key of the scope's tombstone. */
export function coordinationTombstoneKey(scope: CoordinationStateScope): string {
  return `${coordinationScopePrefix(scope)}_tombstone.json`;
}

/**
 * The prefix holding one scope's artifacts.
 *
 * The four scope components appear in the same order as in the state row's
 * partition key, so an operator reading one can find the other. They are
 * validated by {@link assertArtifactKeyComponent} rather than escaped: a
 * component that could contain `/` would silently reshape the prefix, and a
 * reshaped prefix is a cross-tenant read.
 */
export function coordinationScopePrefix(scope: CoordinationStateScope): string {
  return (
    COORDINATION_ARTIFACT_PREFIX +
    [
      assertArtifactKeyComponent(scope.tenantId, "tenantId"),
      assertArtifactKeyComponent(scope.eventId, "eventId"),
      assertArtifactKeyComponent(scope.problemId, "problemId"),
      assertArtifactKeyComponent(scope.runId, "runId"),
    ].join("/") +
    "/"
  );
}

/** Object key of one artifact. */
export function coordinationArtifactKey(scope: CoordinationStateScope, artifactId: string): string {
  return `${coordinationScopePrefix(scope)}${assertArtifactKeyComponent(artifactId, "artifactId")}`;
}

/**
 * Characters permitted in any component of an artifact key.
 *
 * Deliberately narrower than S3 allows. The components come from tenant,
 * event, problem and run identifiers plus a platform-issued artifact id, all of
 * which are already constrained to this alphabet elsewhere; anything outside it
 * is a bug or an attack, and in either case guessing an escaping is worse than
 * refusing.
 */
const ARTIFACT_KEY_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertArtifactKeyComponent(value: string, label: string): string {
  if (!ARTIFACT_KEY_COMPONENT_RE.test(value)) {
    throw new RangeError(`coordination artifact ${label} is not a valid key component: ${value}`);
  }
  return value;
}

/**
 * Collects every `artifactId` reachable in a projection.
 *
 * This is how the platform decides whether a participant may fetch a body,
 * and the choice of "reachable in YOUR projection" is the point: the plugin
 * already decides what each team may see, through `projectForTeam`. Reusing
 * that decision means the fetch endpoint needs no new plugin API and cannot
 * disagree with the board the participant is looking at — if you can see the
 * reference, you can fetch what it points at, and if you cannot, you cannot.
 *
 * The walk is shape-agnostic (a projection is plugin-defined `unknown`) and
 * depth-limited, because a projection is data from a plugin and a cyclic or
 * pathologically deep one must cost a bounded amount rather than the request.
 */
export function collectProjectedArtifactIds(
  projection: unknown,
  maxDepth = 12,
): ReadonlySet<string> {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const id = record.artifactId;
    if (typeof id === "string" && id.length > 0) found.add(id);
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(projection, 0);
  return found;
}
