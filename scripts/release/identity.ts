import {
  DIGEST_PINNED_IMAGE,
  FULL_COMMIT,
  parseToolchain,
  type ReleaseManifest,
  type ReleaseStatus,
  type ReleaseToolchain,
} from "./manifest";
import { enumAt, exactObject, stringMatching, type UnknownRecord } from "./manifest-fields";

/**
 * The resolved identity of one publishable release (#3024): the checked-in manifest's
 * BOM joined with the platform commit that only exists once the `v<version>` tag does.
 * The manifest cannot record that commit itself — it lives inside the tagged tree — so
 * this join is the single place where "tag" and "BOM" become one identity. Downstream
 * consumers (release workflow, attestation, launcher bindings) read this shape, never
 * the tag name alone.
 */
export interface ReleaseIdentity {
  readonly tag: string;
  readonly version: string;
  readonly status: ReleaseStatus;
  readonly platformCommit: string;
  readonly catalogCommit: string;
  readonly simulatorImage: string;
  readonly toolchain: ReleaseToolchain;
}

export interface ReleaseTagContext {
  /** The tag being published, e.g. `v1.4.0`. */
  readonly tag: string;
  /** The commit the tag points at (`git rev-parse <tag>^{commit}`). */
  readonly tagCommit: string;
  /** The `problems` gitlink recorded in the tag commit's tree (`git ls-tree <tag> problems`). */
  readonly catalogGitlink: string;
}

// Exported: the post-publish completeness guard (release-published-completeness.ts) reuses
// this exact shape to derive a version from a tag it only ever receives from the GitHub
// release webhook payload, never from a local checkout — see that module's header comment.
export const STABLE_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message: string): never {
  throw new Error(`Release identity mismatch: ${message}`);
}

/**
 * The fields that say which release this is and what BOM it names. Shared vocabulary for
 * every document that carries a release identity — the resolved identity itself and the
 * attestation published beside it (#3024) — so the two can never disagree about what a
 * valid commit, digest, or status looks like. Callers own the object shape around it.
 */
export type ReleaseBomFields = Omit<ReleaseIdentity, "toolchain">;

export function parseReleaseBomFields(record: UnknownRecord): ReleaseBomFields {
  return {
    tag: stringMatching(
      record.tag,
      "$.tag",
      STABLE_RELEASE_TAG,
      "expected a stable v<major>.<minor>.<patch> release tag",
    ),
    version: stringMatching(
      record.version,
      "$.version",
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
      "expected a stable X.Y.Z release version",
    ),
    status: enumAt(record.status, "$.status", ["candidate", "certified"] as const),
    platformCommit: stringMatching(
      record.platformCommit,
      "$.platformCommit",
      FULL_COMMIT,
      "expected a lowercase full 40-hex platform commit",
    ),
    catalogCommit: stringMatching(
      record.catalogCommit,
      "$.catalogCommit",
      FULL_COMMIT,
      "expected a lowercase full 40-hex catalog commit",
    ),
    simulatorImage: stringMatching(
      record.simulatorImage,
      "$.simulatorImage",
      DIGEST_PINNED_IMAGE,
      "expected an OCI image pinned by a lowercase sha256 digest",
    ),
  };
}

/**
 * Re-validates a resolved identity that crossed a process boundary (the release
 * workflow pipes `verify-release-identity` output into the attestation generator).
 * The same fail-closed vocabulary as the manifest parser: unknown fields, mutable
 * refs, and tag/version disagreement are all rejected.
 */
export function parseReleaseIdentity(value: unknown): ReleaseIdentity {
  const record = exactObject(value, "$", [
    "tag",
    "version",
    "status",
    "platformCommit",
    "catalogCommit",
    "simulatorImage",
    "toolchain",
  ]);
  const identity: ReleaseIdentity = {
    ...parseReleaseBomFields(record),
    toolchain: parseToolchain(record.toolchain, "$.toolchain"),
  };
  if (identity.tag !== `v${identity.version}`) {
    fail(
      `identity tag ${JSON.stringify(identity.tag)} does not match its version ` +
        JSON.stringify(identity.version),
    );
  }
  return identity;
}

/**
 * Joins the parsed manifest with the git facts of a `v*` tag, failing closed on any
 * disagreement. Every check here is a publish blocker from #3024: a release whose tag,
 * manifest version, platform tree, and catalog pin do not agree must not exist.
 */
export function resolveReleaseIdentity(
  manifest: ReleaseManifest,
  context: ReleaseTagContext,
): ReleaseIdentity {
  if (!STABLE_RELEASE_TAG.test(context.tag)) {
    fail(`tag ${JSON.stringify(context.tag)} is not a stable v<major>.<minor>.<patch> release tag`);
  }
  if (context.tag !== `v${manifest.release.version}`) {
    fail(
      `tag ${JSON.stringify(context.tag)} does not match the manifest release version ` +
        `${JSON.stringify(manifest.release.version)} (expected tag v${manifest.release.version})`,
    );
  }
  if (!FULL_COMMIT.test(context.tagCommit)) {
    fail(`tag commit ${JSON.stringify(context.tagCommit)} is not a lowercase full 40-hex commit`);
  }
  if (context.catalogGitlink !== manifest.sources.catalog.commit) {
    fail(
      `the problems gitlink ${JSON.stringify(context.catalogGitlink)} recorded in the tagged tree ` +
        `does not match the manifest catalog commit ${JSON.stringify(manifest.sources.catalog.commit)}`,
    );
  }
  for (const run of manifest.verification.goldenPathRuns) {
    if (run.bom.platformCommit !== context.tagCommit) {
      fail(
        `Golden Path run ${JSON.stringify(run.runId)} exercised platform commit ` +
          `${JSON.stringify(run.bom.platformCommit)}, not the tagged commit ` +
          `${JSON.stringify(context.tagCommit)}; its evidence cannot certify this release`,
      );
    }
  }
  return {
    tag: context.tag,
    version: manifest.release.version,
    status: manifest.release.status,
    platformCommit: context.tagCommit,
    catalogCommit: manifest.sources.catalog.commit,
    simulatorImage: manifest.artifacts.simulatorImage,
    toolchain: manifest.toolchain,
  };
}
