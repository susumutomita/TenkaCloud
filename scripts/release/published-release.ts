import {
  type AttestedAsset,
  parseReleaseAttestation,
  parseSha256Sums,
  RELEASE_ATTESTATION_FILENAME,
  type ReleaseAttestation,
  requiredReleaseAssets,
  type WorkflowIdentity,
} from "./generate-release-attestation";
import type { ReleaseIdentity } from "./identity";

/**
 * Verifies a GitHub Release that is already published (#3024 PR 5).
 *
 * Everything up to `gh release create` is verified by the workflow that builds it, from
 * inputs it produced itself. This module verifies the opposite direction: it starts from
 * the bytes GitHub actually serves and proves they are the release the tag claims —
 * complete asset set, checksums over the published bytes, an attestation that agrees with
 * the identity resolved from the tag, and a `releases/latest/download` URL that serves
 * this release rather than an older one. That is the check a third party can repeat, so
 * it is a pure function over fetched inputs with no I/O of its own.
 *
 * Published releases are immutable here, so the output is evidence, not a repair plan: a
 * failed check means the release must be recreated, never patched.
 */

export const SHA256SUMS_FILENAME = "SHA256SUMS";
export const LATEST_DOWNLOAD_ASSET = "tenkacloud-cli.tgz";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release-cli.yml";
export const PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** One asset attached to the published release, hashed from the bytes GitHub served. */
export interface PublishedAsset {
  readonly name: string;
  readonly sha256: string;
}

export interface LatestDownloadInput {
  /**
   * Whether `releases/latest/download/` must serve this release. True for a freshly
   * published stable tag; false when re-verifying an older tag, where a newer release
   * legitimately owns that URL.
   */
  readonly required: boolean;
  /** `tag_name` of the repository's latest release, or null when it has none. */
  readonly latestReleaseTag: string | null;
  /** SHA-256 of the bytes served by the latest-download URL, or null when not fetched. */
  readonly sha256: string | null;
}

/** Digests of the files as they exist in the tagged tree, read from git, not from GitHub. */
export interface TaggedTreeDigests {
  readonly manifestSha256: string;
  readonly reportSha256: string;
}

export interface PublishedReleaseInput {
  readonly identity: ReleaseIdentity;
  /** `owner/name` the release must belong to, derived from the tagged manifest. */
  readonly repository: string;
  readonly releaseUrl: string;
  readonly assets: readonly PublishedAsset[];
  /** Text of the published SHA256SUMS asset, or null when it is not attached. */
  readonly sha256sums: string | null;
  /** Text of the published attestation asset, or null when it is not attached. */
  readonly attestationJson: string | null;
  readonly taggedTree: TaggedTreeDigests;
  readonly latestDownload: LatestDownloadInput;
  readonly verifiedAt: string;
}

export interface VerificationCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PublishedReleaseEvidence {
  readonly schemaVersion: typeof PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION;
  readonly verifiedAt: string;
  readonly repository: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly identity: ReleaseIdentity;
  readonly assets: readonly PublishedAsset[];
  /** The run that produced the release, once the attestation parses; null otherwise. */
  readonly workflow: WorkflowIdentity | null;
  readonly checks: readonly VerificationCheck[];
  readonly verified: boolean;
}

function passed(id: string, detail: string): VerificationCheck {
  return { id, passed: true, detail };
}

function failed(id: string, detail: string): VerificationCheck {
  return { id, passed: false, detail };
}

/** Code-unit order, not locale order: evidence must not depend on the verifying machine's ICU data. */
function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedNames(names: Iterable<string>): string[] {
  return [...names].sort(compareNames);
}

function describeList(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(", ");
}

/** The complete asset set a published release must carry: hashed artifacts, their sums, and the attestation. */
export function publishedReleaseAssetNames(version: string): readonly string[] {
  return [...requiredReleaseAssets(version), SHA256SUMS_FILENAME, RELEASE_ATTESTATION_FILENAME];
}

function checkAssetSet(input: PublishedReleaseInput): VerificationCheck {
  const id = "release-assets-complete";
  const expected = sortedNames(publishedReleaseAssetNames(input.identity.version));
  const published = sortedNames(input.assets.map((asset) => asset.name));
  const missing = expected.filter((name) => !published.includes(name));
  const unexpected = published.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [
      missing.length > 0 ? `missing ${describeList(missing)}` : "",
      unexpected.length > 0 ? `unexpected ${describeList(unexpected)}` : "",
    ].filter((part) => part !== "");
    return failed(id, `The published asset set is wrong: ${parts.join("; ")}.`);
  }
  return passed(
    id,
    `All ${expected.length} required assets are attached: ${describeList(expected)}.`,
  );
}

function checkSumsCoverage(
  input: PublishedReleaseInput,
  sums: readonly AttestedAsset[] | null,
  sumsError: string | null,
): VerificationCheck {
  const id = "sha256sums-cover-hashed-assets";
  if (sums === null) {
    return failed(id, `SHA256SUMS is unusable: ${sumsError ?? "the asset is not attached"}.`);
  }
  const expected = sortedNames(requiredReleaseAssets(input.identity.version));
  const listed = sortedNames(sums.map((asset) => asset.name));
  if (describeList(expected) !== describeList(listed)) {
    return failed(
      id,
      `SHA256SUMS lists ${describeList(listed)}; the hashed asset set is exactly ${describeList(expected)}.`,
    );
  }
  return passed(id, `SHA256SUMS hashes exactly ${describeList(expected)}.`);
}

function checkPublishedBytes(
  input: PublishedReleaseInput,
  sums: readonly AttestedAsset[] | null,
): VerificationCheck {
  const id = "published-bytes-match-sha256sums";
  if (sums === null)
    return failed(id, "SHA256SUMS is unusable, so the published bytes are unverified.");
  const published = new Map(input.assets.map((asset) => [asset.name, asset.sha256]));
  const mismatches = sums
    .filter((asset) => published.get(asset.name) !== asset.sha256)
    .map(
      (asset) =>
        `${asset.name} (SHA256SUMS ${asset.sha256}, downloaded ${published.get(asset.name) ?? "absent"})`,
    );
  if (mismatches.length > 0) {
    return failed(id, `Downloaded bytes disagree with SHA256SUMS: ${mismatches.join("; ")}.`);
  }
  return passed(id, `Every hashed asset's downloaded bytes match its SHA256SUMS digest.`);
}

function checkAttestedIdentity(
  input: PublishedReleaseInput,
  attestation: ReleaseAttestation | null,
  attestationError: string | null,
): VerificationCheck {
  const id = "attestation-matches-tag-identity";
  if (attestation === null) {
    return failed(
      id,
      `${RELEASE_ATTESTATION_FILENAME} is unusable: ${attestationError ?? "the asset is not attached"}.`,
    );
  }
  const { identity } = input;
  const disagreements = (
    [
      ["tag", attestation.tag, identity.tag],
      ["version", attestation.version, identity.version],
      ["status", attestation.status, identity.status],
      ["platformCommit", attestation.platformCommit, identity.platformCommit],
      ["catalogCommit", attestation.catalogCommit, identity.catalogCommit],
      ["simulatorImage", attestation.simulatorImage, identity.simulatorImage],
    ] as const
  )
    .filter(([, attested, resolved]) => attested !== resolved)
    .map(([field, attested, resolved]) => `${field} (attested ${attested}, tag ${resolved})`);
  if (disagreements.length > 0) {
    return failed(
      id,
      `The attestation describes a different release than the tag: ${disagreements.join("; ")}.`,
    );
  }
  return passed(
    id,
    `The attestation binds ${identity.tag} to platform ${identity.platformCommit}, catalog ` +
      `${identity.catalogCommit}, and ${identity.simulatorImage}.`,
  );
}

function checkAttestedAssets(
  attestation: ReleaseAttestation | null,
  sums: readonly AttestedAsset[] | null,
  published: readonly PublishedAsset[],
): VerificationCheck {
  const id = "attestation-matches-published-assets";
  if (attestation === null || sums === null) {
    return failed(
      id,
      "The attestation or SHA256SUMS is unusable, so the asset digests are unverified.",
    );
  }
  const attested = new Map(attestation.assets.map((asset) => [asset.name, asset.sha256]));
  const disagreements = sums
    .filter((asset) => attested.get(asset.name) !== asset.sha256)
    .map(
      (asset) =>
        `${asset.name} (attested ${attested.get(asset.name) ?? "absent"}, SHA256SUMS ${asset.sha256})`,
    );
  for (const asset of attestation.assets) {
    if (!sums.some((hashed) => hashed.name === asset.name)) {
      disagreements.push(`${asset.name} (attested but not in SHA256SUMS)`);
    }
  }
  const manifestDigest = published.find((asset) => asset.name === "release-manifest.json")?.sha256;
  if (attestation.manifestSha256 !== manifestDigest) {
    disagreements.push(
      `manifestSha256 (attested ${attestation.manifestSha256}, downloaded ${manifestDigest ?? "absent"})`,
    );
  }
  if (disagreements.length > 0) {
    return failed(
      id,
      `The attestation disagrees with the published assets: ${disagreements.join("; ")}.`,
    );
  }
  return passed(
    id,
    `The attestation covers every hashed asset and the published manifest digest ${attestation.manifestSha256}.`,
  );
}

function checkAttestedProvenance(
  input: PublishedReleaseInput,
  attestation: ReleaseAttestation | null,
): VerificationCheck {
  const id = "attestation-names-the-release-workflow-run";
  if (attestation === null) {
    return failed(
      id,
      `${RELEASE_ATTESTATION_FILENAME} is unusable, so the release has no provenance.`,
    );
  }
  const { workflow } = attestation;
  const expectedRefPrefix = `${input.repository}/${RELEASE_WORKFLOW_PATH}@`;
  if (workflow.repository !== input.repository) {
    return failed(
      id,
      `The attestation was produced in ${workflow.repository}, not ${input.repository}.`,
    );
  }
  if (!workflow.workflowRef.startsWith(expectedRefPrefix)) {
    return failed(
      id,
      `The attestation names workflow ${workflow.workflowRef}, not ${expectedRefPrefix}<ref>.`,
    );
  }
  return passed(
    id,
    `Produced by ${workflow.workflowRef} run ${workflow.runId} attempt ${workflow.runAttempt}.`,
  );
}

function checkTaggedTreeBytes(input: PublishedReleaseInput): VerificationCheck {
  const id = "published-documents-match-the-tagged-tree";
  const published = new Map(input.assets.map((asset) => [asset.name, asset.sha256]));
  const disagreements = (
    [
      ["release-manifest.json", input.taggedTree.manifestSha256],
      ["release-report.md", input.taggedTree.reportSha256],
    ] as const
  )
    .filter(([name, tagged]) => published.get(name) !== tagged)
    .map(
      ([name, tagged]) =>
        `${name} (published ${published.get(name) ?? "absent"}, tagged ${tagged})`,
    );
  if (disagreements.length > 0) {
    return failed(
      id,
      `Published documents differ from the files in the tagged tree: ${disagreements.join("; ")}.`,
    );
  }
  return passed(
    id,
    "The published manifest and report are byte-identical to the files in the tagged tree.",
  );
}

function checkLatestDownload(input: PublishedReleaseInput): VerificationCheck {
  const id = "latest-download-serves-this-release";
  const { latestDownload, identity } = input;
  const publishedDigest = input.assets.find(
    (asset) => asset.name === LATEST_DOWNLOAD_ASSET,
  )?.sha256;
  if (latestDownload.latestReleaseTag !== identity.tag) {
    const detail =
      `The repository's latest release is ${latestDownload.latestReleaseTag ?? "none"}, not ${identity.tag}, ` +
      `so releases/latest/download/${LATEST_DOWNLOAD_ASSET} does not serve this release.`;
    return latestDownload.required ? failed(id, detail) : passed(id, `Not applicable: ${detail}`);
  }
  if (latestDownload.sha256 === null) {
    return failed(id, `releases/latest/download/${LATEST_DOWNLOAD_ASSET} was not retrievable.`);
  }
  if (latestDownload.sha256 !== publishedDigest) {
    return failed(
      id,
      `releases/latest/download/${LATEST_DOWNLOAD_ASSET} served ${latestDownload.sha256}, but this ` +
        `release publishes ${publishedDigest ?? "no such asset"}.`,
    );
  }
  return passed(
    id,
    `releases/latest/download/${LATEST_DOWNLOAD_ASSET} serves this release's ${latestDownload.sha256}.`,
  );
}

function checkTarballCopies(input: PublishedReleaseInput): VerificationCheck {
  const id = "unversioned-tarball-copies-the-versioned-one";
  const published = new Map(input.assets.map((asset) => [asset.name, asset.sha256]));
  const versioned = published.get(`tenkacloud-cli-${input.identity.version}.tgz`);
  const unversioned = published.get(LATEST_DOWNLOAD_ASSET);
  if (versioned === undefined || unversioned === undefined || versioned !== unversioned) {
    return failed(
      id,
      `tenkacloud-cli-${input.identity.version}.tgz (${versioned ?? "absent"}) and ` +
        `${LATEST_DOWNLOAD_ASSET} (${unversioned ?? "absent"}) are not the same bytes.`,
    );
  }
  return passed(id, `Both CLI tarballs are the same bytes (${versioned}).`);
}

/**
 * Runs every published-release check and returns the evidence record. Checks never throw:
 * an unusable asset fails its own check and the ones that depend on it, so one broken
 * release still produces a complete report instead of stopping at the first problem.
 */
export function verifyPublishedRelease(input: PublishedReleaseInput): PublishedReleaseEvidence {
  let sums: readonly AttestedAsset[] | null = null;
  let sumsError: string | null = null;
  if (input.sha256sums === null) {
    sumsError = "the asset is not attached";
  } else {
    try {
      sums = parseSha256Sums(input.sha256sums);
    } catch (error) {
      sumsError = error instanceof Error ? error.message : String(error);
    }
  }

  let attestation: ReleaseAttestation | null = null;
  let attestationError: string | null = null;
  if (input.attestationJson === null) {
    attestationError = "the asset is not attached";
  } else {
    try {
      attestation = parseReleaseAttestation(JSON.parse(input.attestationJson));
    } catch (error) {
      attestationError = error instanceof Error ? error.message : String(error);
    }
  }

  const checks: readonly VerificationCheck[] = [
    checkAssetSet(input),
    checkSumsCoverage(input, sums, sumsError),
    checkPublishedBytes(input, sums),
    checkTarballCopies(input),
    checkTaggedTreeBytes(input),
    checkAttestedIdentity(input, attestation, attestationError),
    checkAttestedAssets(attestation, sums, input.assets),
    checkAttestedProvenance(input, attestation),
    checkLatestDownload(input),
  ];

  return {
    schemaVersion: PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION,
    verifiedAt: input.verifiedAt,
    repository: input.repository,
    tag: input.identity.tag,
    releaseUrl: input.releaseUrl,
    identity: input.identity,
    assets: [...input.assets].sort((left, right) => compareNames(left.name, right.name)),
    workflow: attestation?.workflow ?? null,
    checks,
    verified: checks.every((check) => check.passed),
  };
}

/** `https://github.com/owner/name.git` → `owner/name`, the form GitHub's API and `GITHUB_REPOSITORY` use. */
export function repositorySlug(repositoryUrl: string): string {
  const path = new URL(repositoryUrl).pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(path)) {
    throw new Error(`Cannot derive an owner/name slug from ${JSON.stringify(repositoryUrl)}.`);
  }
  return path;
}
