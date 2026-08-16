import { createHash } from "node:crypto";
import type { LauncherDefaults } from "./generate-launcher-defaults";
import {
  type AttestedAsset,
  parseReleaseAttestation,
  parseSha256Sums,
  RELEASE_ATTESTATION_FILENAME,
  type ReleaseAttestation,
  requiredReleaseAssets,
  SHA256_HEX,
} from "./generate-release-attestation";
import { renderReleaseReport } from "./generate-release-report";
import { FULL_COMMIT, parseReleaseManifest, type ReleaseManifest } from "./manifest";

/**
 * The release-contract rules a published GitHub Release must satisfy (#3024 PR 5).
 *
 * This module is pure: it decides, and never fetches. `verify-published-release.ts` owns
 * downloading a real Release and feeding it here, which is what lets the same rules run
 * over live bytes in CI and over fixtures in tests.
 *
 * Every other release gate in this repository runs BEFORE publication and reads the
 * working tree. This one runs after, reads only what the Release actually serves to a
 * third party, and answers the question the issue exists to make answerable: does one
 * tag resolve to exactly one BOM everywhere a user can observe it?
 *
 * The chain it closes, entirely from downloaded bytes plus the forge's own tag→commit
 * answer:
 *
 *   tag → commit → attestation → SHA256SUMS → asset bytes → manifest → report
 *                                                              ↓
 *                                                    launcher default pair
 *
 * Nothing here trusts the tag name, and nothing trusts the checked-in tree except the
 * launcher binding it is asserting about. A release that passes has no path left by
 * which its GitHub Release, its CLI tarball, its generated report, and the Lite
 * launcher's default refs could be describing different software.
 */

export const SHA256SUMS_FILENAME = "SHA256SUMS";
export const PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const UNVERSIONED_CLI_ASSET = "tenkacloud-cli.tgz";
export const RELEASE_MANIFEST_ASSET = "release-manifest.json";
export const RELEASE_REPORT_ASSET = "release-report.md";

const STABLE_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The complete published asset set: the hashed artifacts, the sums over them, and the
 * attestation that binds both. `requiredReleaseAssets` deliberately excludes the last two
 * (SHA256SUMS cannot hash itself, and the attestation embeds the sums), so a verifier
 * needs this wider list to assert the set is closed.
 */
export function publishedReleaseAssetNames(version: string): readonly string[] {
  return [...requiredReleaseAssets(version), SHA256SUMS_FILENAME, RELEASE_ATTESTATION_FILENAME];
}

export interface DownloadedAsset {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface PublishedReleaseInput {
  /** The published tag under verification, e.g. `v1.4.0`. */
  readonly tag: string;
  /** The commit that tag resolves to, read back from the forge — never from the manifest. */
  readonly tagCommit: string;
  /** Every asset the published Release carries, downloaded back from it. */
  readonly assets: readonly DownloadedAsset[];
  /** SHA-256 of the bytes served by `releases/latest/download/tenkacloud-cli.tgz`. */
  readonly latestDownloadSha256: string;
  /** The checked-in launcher binding, which must point at this published BOM. */
  readonly launcherDefaults: LauncherDefaults;
  readonly verifiedAt: string;
}

export interface PublishedReleaseEvidence {
  readonly schemaVersion: typeof PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION;
  readonly tag: string;
  readonly version: string;
  readonly status: ReleaseAttestation["status"];
  readonly platformCommit: string;
  readonly catalogCommit: string;
  readonly simulatorImage: string;
  readonly manifestSha256: string;
  readonly assets: readonly AttestedAsset[];
  readonly workflow: ReleaseAttestation["workflow"];
  /** The verified invariants, in the order they were established. */
  readonly checks: readonly string[];
  readonly verifiedAt: string;
}

/** The one failure vocabulary for this contract, shared with the collection layer. */
export function fail(message: string): never {
  throw new Error(`Published release verification failed: ${message}`);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(name: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`published asset ${JSON.stringify(name)} is not valid UTF-8`);
  }
}

function parseJsonAsset(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`published asset ${JSON.stringify(name)} is not valid JSON: ${message}`);
  }
}

/**
 * The published bytes, indexed and hashed once. Each verification step below reads only
 * this and the inputs it is asserting about, so the steps stay independently readable.
 */
interface PublishedAssets {
  readonly version: string;
  /** The assets SHA256SUMS and the attestation cover — everything except those two. */
  readonly hashed: readonly string[];
  readonly textOf: (name: string) => string;
  readonly digestOf: (name: string) => string;
}

/**
 * Indexes the published assets and asserts the set is closed: exactly the required files,
 * each exactly once. Every later step may then look assets up without re-proving presence.
 */
function indexPublishedAssets(
  assets: readonly DownloadedAsset[],
  version: string,
): PublishedAssets {
  const bytesByName = new Map<string, Uint8Array>();
  for (const asset of assets) {
    if (bytesByName.has(asset.name)) {
      fail(`the published release carries ${JSON.stringify(asset.name)} more than once`);
    }
    bytesByName.set(asset.name, asset.bytes);
  }
  const expected = publishedReleaseAssetNames(version);
  for (const name of expected) {
    if (!bytesByName.has(name)) {
      fail(`required asset ${JSON.stringify(name)} is missing from the published release`);
    }
  }
  for (const name of bytesByName.keys()) {
    if (!expected.includes(name)) {
      fail(`unexpected published asset ${JSON.stringify(name)}; the release asset set is closed`);
    }
  }
  const digestByName = new Map(
    [...bytesByName].map(([name, bytes]) => [name, sha256(bytes)] as const),
  );
  return {
    version,
    hashed: requiredReleaseAssets(version),
    textOf: (name) => {
      const bytes = bytesByName.get(name);
      if (!bytes) fail(`required asset ${JSON.stringify(name)} is missing from the release`);
      return decodeUtf8(name, bytes);
    },
    digestOf: (name) => {
      const digest = digestByName.get(name);
      if (!digest) fail(`required asset ${JSON.stringify(name)} was never hashed`);
      return digest;
    },
  };
}

/**
 * Asserts SHA256SUMS covers exactly the hashed asset set and that every digest in it matches
 * the bytes the release actually serves. This is the step that catches an asset replaced
 * after it was hashed.
 */
function assertSumsMatchServedBytes(published: PublishedAssets): void {
  const sums = parseSha256Sums(published.textOf(SHA256SUMS_FILENAME));
  const declaredByName = new Map(sums.map((asset) => [asset.name, asset.sha256]));
  if (declaredByName.size !== sums.length) fail("SHA256SUMS lists the same asset more than once");
  for (const name of declaredByName.keys()) {
    if (!published.hashed.includes(name)) {
      fail(`SHA256SUMS covers unexpected asset ${JSON.stringify(name)}`);
    }
  }
  for (const name of published.hashed) {
    const declared = declaredByName.get(name);
    if (!declared) fail(`SHA256SUMS does not cover required asset ${JSON.stringify(name)}`);
    const actual = published.digestOf(name);
    if (declared !== actual) {
      fail(
        `published asset ${JSON.stringify(name)} hashes to ${actual}, but SHA256SUMS ` +
          `declares ${declared}`,
      );
    }
  }
}

/** Asserts the attestation was issued for this exact tag, version, and tag commit. */
function assertAttestationIdentity(
  attestation: ReleaseAttestation,
  input: PublishedReleaseInput,
  version: string,
): void {
  if (attestation.tag !== input.tag) {
    fail(
      `the attestation was issued for tag ${JSON.stringify(attestation.tag)}, not ` +
        JSON.stringify(input.tag),
    );
  }
  if (attestation.version !== version) {
    fail(
      `the attestation declares version ${JSON.stringify(attestation.version)}, which is not ` +
        `the version of tag ${JSON.stringify(input.tag)}`,
    );
  }
  if (attestation.platformCommit !== input.tagCommit) {
    fail(
      `the attestation binds platform commit ${JSON.stringify(attestation.platformCommit)}, but ` +
        `tag ${JSON.stringify(input.tag)} resolves to ${JSON.stringify(input.tagCommit)}`,
    );
  }
}

/** Asserts the attestation's digests cover, and agree with, the published bytes. */
function assertAttestationDigests(
  attestation: ReleaseAttestation,
  published: PublishedAssets,
): void {
  const attestedByName = new Map(attestation.assets.map((asset) => [asset.name, asset.sha256]));
  if (attestedByName.size !== attestation.assets.length) {
    fail("the attestation lists the same asset more than once");
  }
  for (const name of published.hashed) {
    const attested = attestedByName.get(name);
    if (!attested) fail(`the attestation does not cover required asset ${JSON.stringify(name)}`);
    const served = published.digestOf(name);
    if (attested !== served) {
      fail(
        `the attestation declares ${JSON.stringify(name)} as ${attested}, but the release ` +
          `serves ${served}`,
      );
    }
  }
  for (const name of attestedByName.keys()) {
    if (!published.hashed.includes(name)) {
      fail(`the attestation covers unexpected asset ${JSON.stringify(name)}`);
    }
  }
  const manifestDigest = published.digestOf(RELEASE_MANIFEST_ASSET);
  if (attestation.manifestSha256 !== manifestDigest) {
    fail(
      `the attestation's manifest digest ${attestation.manifestSha256} does not match the ` +
        `published manifest digest ${manifestDigest}`,
    );
  }
}

/** Asserts the published manifest describes the same BOM the attestation binds. */
function assertManifestMatchesAttestation(
  manifest: ReleaseManifest,
  attestation: ReleaseAttestation,
  version: string,
): void {
  if (manifest.release.version !== version) {
    fail(
      `the published manifest declares version ${JSON.stringify(manifest.release.version)}, not ` +
        JSON.stringify(version),
    );
  }
  if (manifest.release.status !== attestation.status) {
    fail(
      `the published manifest is ${JSON.stringify(manifest.release.status)}, but the attestation ` +
        `records ${JSON.stringify(attestation.status)}`,
    );
  }
  if (manifest.sources.catalog.commit !== attestation.catalogCommit) {
    fail(
      `the published manifest pins catalog ${JSON.stringify(manifest.sources.catalog.commit)}, ` +
        `but the attestation binds ${JSON.stringify(attestation.catalogCommit)}`,
    );
  }
  if (manifest.artifacts.simulatorImage !== attestation.simulatorImage) {
    fail(
      `the published manifest pins Simulator ${JSON.stringify(manifest.artifacts.simulatorImage)}, ` +
        `but the attestation binds ${JSON.stringify(attestation.simulatorImage)}`,
    );
  }
}

/**
 * Asserts the unversioned tarball is an alias of this release's tarball, and that the
 * `releases/latest/download/` URL — the one install instructions point at — serves it.
 */
function assertCliArtifacts(published: PublishedAssets, latestDownloadSha256: string): void {
  const versioned = published.digestOf(`tenkacloud-cli-${published.version}.tgz`);
  if (published.digestOf(UNVERSIONED_CLI_ASSET) !== versioned) {
    fail(
      `${UNVERSIONED_CLI_ASSET} and tenkacloud-cli-${published.version}.tgz are different bytes; ` +
        "the unversioned asset must be an alias of this release's tarball",
    );
  }
  if (latestDownloadSha256 !== versioned) {
    fail(
      `releases/latest/download/${UNVERSIONED_CLI_ASSET} serves ${latestDownloadSha256}, ` +
        `not this release's tarball ${versioned}`,
    );
  }
}

/**
 * Asserts the Lite launcher's checked-in default pair points at this release's BOM. This is
 * the one step that reads the repository rather than the download: it is the claim that the
 * launcher a user runs deploys the software this tag published.
 */
function assertLauncherBinding(
  launcherDefaults: LauncherDefaults,
  attestation: ReleaseAttestation,
  version: string,
): void {
  if (launcherDefaults.platformCommit !== attestation.platformCommit) {
    fail(
      `the Lite launcher default RepoRef ${JSON.stringify(launcherDefaults.platformCommit)} ` +
        `is not this release's platform commit ${JSON.stringify(attestation.platformCommit)}`,
    );
  }
  if (launcherDefaults.catalogCommit !== attestation.catalogCommit) {
    fail(
      "the Lite launcher default ProblemsRepoRef " +
        `${JSON.stringify(launcherDefaults.catalogCommit)} is not this release's catalog ` +
        `commit ${JSON.stringify(attestation.catalogCommit)}`,
    );
  }
  if (launcherDefaults.manifestVersion !== version) {
    fail(
      "the Lite launcher reports manifest version " +
        `${JSON.stringify(launcherDefaults.manifestVersion)}, not ${JSON.stringify(version)}`,
    );
  }
}

/** Asserts the tag and the two loose digests in `input` are well-formed before anything else. */
function assertInputShape(input: PublishedReleaseInput): string {
  if (!STABLE_RELEASE_TAG.test(input.tag)) {
    fail(`tag ${JSON.stringify(input.tag)} is not a stable v<major>.<minor>.<patch> release tag`);
  }
  if (!FULL_COMMIT.test(input.tagCommit)) {
    fail(`tag commit ${JSON.stringify(input.tagCommit)} is not a lowercase full 40-hex commit`);
  }
  if (!SHA256_HEX.test(input.latestDownloadSha256)) {
    fail(
      `the latest-download digest ${JSON.stringify(input.latestDownloadSha256)} ` +
        "is not a lowercase 64-hex sha256",
    );
  }
  return input.tag.slice(1);
}

/**
 * Verifies one published Release against the release contract, failing closed on the first
 * disagreement. Pure: every fact it checks arrives through `input`, so the same function runs
 * over live downloads in CI and over fixtures in tests. The returned evidence lists the
 * invariants that held, in the order they were established.
 */
export function verifyPublishedRelease(input: PublishedReleaseInput): PublishedReleaseEvidence {
  const version = assertInputShape(input);
  const published = indexPublishedAssets(input.assets, version);
  const checks = [
    `the published asset set is exactly the required ${publishedReleaseAssetNames(version).length} files`,
  ];

  assertSumsMatchServedBytes(published);
  checks.push("every SHA256SUMS digest matches the bytes the release actually serves");

  const attestation = parseReleaseAttestation(
    parseJsonAsset(RELEASE_ATTESTATION_FILENAME, published.textOf(RELEASE_ATTESTATION_FILENAME)),
  );
  assertAttestationIdentity(attestation, input, version);
  checks.push("the attestation binds this tag to the commit the tag actually resolves to");

  assertAttestationDigests(attestation, published);
  checks.push("the attestation's manifest and artifact digests match the published bytes");

  const manifest = parseReleaseManifest(
    parseJsonAsset(RELEASE_MANIFEST_ASSET, published.textOf(RELEASE_MANIFEST_ASSET)),
    { now: new Date(input.verifiedAt) },
  );
  assertManifestMatchesAttestation(manifest, attestation, version);
  checks.push("the published manifest declares the same BOM the attestation binds");

  if (published.textOf(RELEASE_REPORT_ASSET) !== renderReleaseReport(manifest)) {
    fail(
      `the published ${RELEASE_REPORT_ASSET} is not what the published manifest generates; a ` +
        "release report must be generated from the manifest, never hand-edited",
    );
  }
  checks.push("the published report regenerates byte-for-byte from the published manifest");

  assertCliArtifacts(published, input.latestDownloadSha256);
  checks.push(
    `releases/latest/download/${UNVERSIONED_CLI_ASSET} serves this release's tarball byte-for-byte`,
  );

  assertLauncherBinding(input.launcherDefaults, attestation, version);
  checks.push("the Lite launcher default pair points at this release's BOM");

  return {
    schemaVersion: PUBLISHED_RELEASE_EVIDENCE_SCHEMA_VERSION,
    tag: input.tag,
    version,
    status: attestation.status,
    platformCommit: attestation.platformCommit,
    catalogCommit: attestation.catalogCommit,
    simulatorImage: attestation.simulatorImage,
    manifestSha256: attestation.manifestSha256,
    assets: published.hashed.map((name) => ({ name, sha256: published.digestOf(name) })),
    workflow: attestation.workflow,
    checks,
    verifiedAt: input.verifiedAt,
  };
}
