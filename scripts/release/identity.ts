import type { ReleaseManifest, ReleaseStatus, ReleaseToolchain } from "./manifest";

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

const STABLE_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;

function fail(message: string): never {
  throw new Error(`Release identity mismatch: ${message}`);
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
