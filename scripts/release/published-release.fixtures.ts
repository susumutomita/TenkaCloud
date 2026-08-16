import type { LauncherDefaults } from "./generate-launcher-defaults";
import {
  buildReleaseAttestation,
  parseSha256Sums,
  RELEASE_ATTESTATION_FILENAME,
  requiredReleaseAssets,
  type WorkflowIdentity,
} from "./generate-release-attestation";
import { renderReleaseReport } from "./generate-release-report";
import type { ReleaseIdentity } from "./identity";
import { parseReleaseManifest } from "./manifest";
import {
  type DownloadedAsset,
  type PublishedReleaseInput,
  publishedReleaseAssetNames,
  RELEASE_MANIFEST_ASSET,
  RELEASE_REPORT_ASSET,
  SHA256SUMS_FILENAME,
  sha256,
  UNVERSIONED_CLI_ASSET,
} from "./published-release";

/**
 * A self-consistent published Release, assembled the same way the release workflow assembles
 * a real one: hash the artifacts, write SHA256SUMS over them, then attest the sums. Tests
 * corrupt exactly one link at a time through `overrides` — every other link stays honest, so
 * a passing negative test proves the verifier caught THAT break and not a fixture accident.
 */

export const TAG = "v1.4.0";
export const VERSION = "1.4.0";
export const PLATFORM_COMMIT = "d".repeat(40);
export const CATALOG_COMMIT = "5".repeat(40);
export const SIMULATOR_IMAGE = `ghcr.io/susumutomita/tenkacloud-simulator@sha256:${"0".repeat(64)}`;
export const VERIFIED_AT = "2026-08-16T09:00:00.000Z";

export const WORKFLOW: WorkflowIdentity = {
  repository: "susumutomita/TenkaCloud",
  runId: "31569275500",
  runAttempt: "1",
  workflowRef: `susumutomita/TenkaCloud/.github/workflows/release-cli.yml@refs/tags/${TAG}`,
};

export const IDENTITY: ReleaseIdentity = {
  tag: TAG,
  version: VERSION,
  status: "candidate",
  platformCommit: PLATFORM_COMMIT,
  catalogCommit: CATALOG_COMMIT,
  simulatorImage: SIMULATOR_IMAGE,
  toolchain: {
    bun: "1.3.11",
    node: { development: "24", launcher: "22" },
    awsCdk: { cli: "2.1133.0", library: "2.262.1" },
  },
};

export const LAUNCHER_DEFAULTS: LauncherDefaults = {
  manifestVersion: VERSION,
  platformCommit: PLATFORM_COMMIT,
  catalogCommit: CATALOG_COMMIT,
};

const encoder = new TextEncoder();

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A minimal candidate manifest — the shape a real published release-manifest.json has. */
export function manifestJson(): string {
  return `${JSON.stringify(
    {
      $schema: "./tenkacloud-release.schema.json",
      schemaVersion: 2,
      release: { version: VERSION, status: "candidate" },
      sources: {
        platform: { repository: "https://github.com/susumutomita/TenkaCloud.git" },
        catalog: {
          repository: "https://github.com/susumutomita/TenkaCloudChallenge.git",
          commit: CATALOG_COMMIT,
        },
      },
      artifacts: { simulatorImage: SIMULATOR_IMAGE },
      toolchain: IDENTITY.toolchain,
      compatibility: {
        qualificationTargets: [{ mode: "lite", regions: ["ap-northeast-1"] }],
        supportedModes: [],
        contracts: [{ id: "problem-pack-manifest", version: "1" }],
      },
      verification: { goldenPathRuns: [] },
      knownLimitations: ["No Golden Path evidence is attached."],
    },
    null,
    2,
  )}\n`;
}

export function publishedAssets(
  overrides: Readonly<Record<string, string>> = {},
): readonly DownloadedAsset[] {
  const manifestText = overrides[RELEASE_MANIFEST_ASSET] ?? manifestJson();
  const manifest = parseReleaseManifest(JSON.parse(manifestText), { now: new Date(VERIFIED_AT) });
  const cliText = overrides[`tenkacloud-cli-${VERSION}.tgz`] ?? "cli-tarball-bytes";
  const contents: Record<string, string> = {
    [`tenkacloud-cli-${VERSION}.tgz`]: cliText,
    [UNVERSIONED_CLI_ASSET]: overrides[UNVERSIONED_CLI_ASSET] ?? cliText,
    [RELEASE_MANIFEST_ASSET]: manifestText,
    [RELEASE_REPORT_ASSET]: overrides[RELEASE_REPORT_ASSET] ?? renderReleaseReport(manifest),
  };
  // The attestation is always built from the canonical sums, so a test can publish a
  // corrupted SHA256SUMS without also making the attestation unbuildable.
  const canonicalSums = `${requiredReleaseAssets(VERSION)
    .map((name) => `${sha256(encoder.encode(contents[name] as string))}  ${name}`)
    .join("\n")}\n`;
  contents[SHA256SUMS_FILENAME] = overrides[SHA256SUMS_FILENAME] ?? canonicalSums;
  const attestation = buildReleaseAttestation({
    identity: IDENTITY,
    sums: parseSha256Sums(canonicalSums),
    workflow: WORKFLOW,
    generatedAt: "2026-08-16T08:00:00.000Z",
  });
  contents[RELEASE_ATTESTATION_FILENAME] =
    overrides[RELEASE_ATTESTATION_FILENAME] ?? `${JSON.stringify(attestation, null, 2)}\n`;
  return publishedReleaseAssetNames(VERSION).map((name) => ({
    name,
    bytes: encoder.encode(contents[name] as string),
  }));
}

export function publishedInput(
  overrides: Partial<PublishedReleaseInput> = {},
): PublishedReleaseInput {
  const assets = overrides.assets ?? publishedAssets();
  const cli = assets.find(({ name }) => name === UNVERSIONED_CLI_ASSET);
  return {
    tag: TAG,
    tagCommit: PLATFORM_COMMIT,
    assets,
    latestDownloadSha256: cli ? sha256(cli.bytes) : "0".repeat(64),
    launcherDefaults: LAUNCHER_DEFAULTS,
    verifiedAt: VERIFIED_AT,
    ...overrides,
  };
}

export function publishedAttestation(): Record<string, unknown> {
  const asset = publishedAssets().find(
    ({ name }) => name === RELEASE_ATTESTATION_FILENAME,
  ) as DownloadedAsset;
  return JSON.parse(decode(asset.bytes));
}

/** Re-serializes the attestation with fields changed, keeping the surrounding release honest. */
export function attestationWith(patch: Record<string, unknown>): string {
  return `${JSON.stringify({ ...publishedAttestation(), ...patch }, null, 2)}\n`;
}

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}
