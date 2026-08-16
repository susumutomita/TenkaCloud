import { describe, expect, it } from "bun:test";
import {
  parseReleaseAttestation,
  RELEASE_ATTESTATION_FILENAME,
  requiredReleaseAssets,
} from "./generate-release-attestation";
import {
  type DownloadedAsset,
  publishedReleaseAssetNames,
  RELEASE_MANIFEST_ASSET,
  RELEASE_REPORT_ASSET,
  SHA256SUMS_FILENAME,
  sha256,
  UNVERSIONED_CLI_ASSET,
  verifyPublishedRelease,
} from "./published-release";
import {
  attestationWith,
  CATALOG_COMMIT,
  decode,
  encode,
  LAUNCHER_DEFAULTS,
  manifestJson,
  PLATFORM_COMMIT,
  publishedAssets,
  publishedAttestation,
  publishedInput,
  SIMULATOR_IMAGE,
  TAG,
  VERIFIED_AT,
  VERSION,
  WORKFLOW,
} from "./published-release.fixtures";

describe("published release verification", () => {
  it("accepts a release whose tag, assets, manifest, report, and launcher all agree", () => {
    const evidence = verifyPublishedRelease(publishedInput());
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.tag).toBe(TAG);
    expect(evidence.version).toBe(VERSION);
    expect(evidence.status).toBe("candidate");
    expect(evidence.platformCommit).toBe(PLATFORM_COMMIT);
    expect(evidence.catalogCommit).toBe(CATALOG_COMMIT);
    expect(evidence.simulatorImage).toBe(SIMULATOR_IMAGE);
    expect(evidence.workflow).toEqual(WORKFLOW);
    expect(evidence.verifiedAt).toBe(VERIFIED_AT);
    expect(evidence.assets.map(({ name }) => name)).toEqual([...requiredReleaseAssets(VERSION)]);
    expect(evidence.checks).toHaveLength(8);
  });

  it("rejects a tag that is not a stable release tag, and a non-commit tag target", () => {
    expect(() => verifyPublishedRelease(publishedInput({ tag: "v1.4" }))).toThrow(
      "is not a stable v<major>.<minor>.<patch> release tag",
    );
    expect(() => verifyPublishedRelease(publishedInput({ tagCommit: "main" }))).toThrow(
      "is not a lowercase full 40-hex commit",
    );
    expect(() =>
      verifyPublishedRelease(publishedInput({ latestDownloadSha256: "not-a-digest" })),
    ).toThrow("is not a lowercase 64-hex sha256");
  });

  it.each(publishedReleaseAssetNames(VERSION))("fails closed when %s is not published", (gone) => {
    const assets = publishedAssets().filter(({ name }) => name !== gone);
    expect(() => verifyPublishedRelease(publishedInput({ assets }))).toThrow(
      `required asset ${JSON.stringify(gone)} is missing from the published release`,
    );
  });

  it("rejects extra and duplicated published assets: the asset set is closed", () => {
    const extra = [...publishedAssets(), { name: "debug.log", bytes: encode("oops") }];
    expect(() => verifyPublishedRelease(publishedInput({ assets: extra }))).toThrow(
      'unexpected published asset "debug.log"',
    );
    const twice = [...publishedAssets(), ...publishedAssets().slice(0, 1)];
    expect(() => verifyPublishedRelease(publishedInput({ assets: twice }))).toThrow(
      "more than once",
    );
  });

  it("rejects a SHA256SUMS digest that does not match the bytes the release serves", () => {
    const assets = publishedAssets().map((asset) =>
      asset.name === RELEASE_REPORT_ASSET
        ? { ...asset, bytes: encode("swapped after hashing") }
        : asset,
    );
    expect(() => verifyPublishedRelease(publishedInput({ assets }))).toThrow(
      'published asset "release-report.md" hashes to',
    );
  });

  it("rejects a SHA256SUMS that does not cover exactly the hashed asset set", () => {
    const short = publishedAssets({
      [SHA256SUMS_FILENAME]: `${sha256(encode("cli-tarball-bytes"))}  ${UNVERSIONED_CLI_ASSET}\n`,
    });
    expect(() => verifyPublishedRelease(publishedInput({ assets: short }))).toThrow(
      "SHA256SUMS does not cover required asset",
    );
    const sums = decode(
      (publishedAssets().find(({ name }) => name === SHA256SUMS_FILENAME) as DownloadedAsset).bytes,
    );
    const withStray = publishedAssets({
      [SHA256SUMS_FILENAME]: `${sums}${"a".repeat(64)}  stray.txt\n`,
    });
    expect(() => verifyPublishedRelease(publishedInput({ assets: withStray }))).toThrow(
      'SHA256SUMS covers unexpected asset "stray.txt"',
    );
  });

  it("rejects an attestation issued for another tag, version, or commit", () => {
    for (const [patch, message] of [
      [{ tag: "v9.9.9", version: "9.9.9" }, "was issued for tag"],
      // An internally inconsistent attestation dies in the parser, before the tag comparison.
      [{ version: "1.5.0" }, "does not match its version"],
      [{ platformCommit: "e".repeat(40) }, "binds platform commit"],
    ] as const) {
      const assets = publishedAssets({ [RELEASE_ATTESTATION_FILENAME]: attestationWith(patch) });
      expect(() => verifyPublishedRelease(publishedInput({ assets }))).toThrow(message);
    }
  });

  it("rejects an attestation whose digests disagree with the published bytes", () => {
    const attested = attestationWith({
      assets: requiredReleaseAssets(VERSION).map((name) => ({ name, sha256: "b".repeat(64) })),
    });
    expect(() =>
      verifyPublishedRelease(
        publishedInput({ assets: publishedAssets({ [RELEASE_ATTESTATION_FILENAME]: attested }) }),
      ),
    ).toThrow("but the release serves");

    const wrongManifestDigest = publishedAssets({
      [RELEASE_ATTESTATION_FILENAME]: attestationWith({ manifestSha256: "c".repeat(64) }),
    });
    expect(() => verifyPublishedRelease(publishedInput({ assets: wrongManifestDigest }))).toThrow(
      "does not match the published manifest digest",
    );
  });

  it("rejects an attestation that covers the wrong asset names", () => {
    const missing = attestationWith({
      assets: [{ name: UNVERSIONED_CLI_ASSET, sha256: "b".repeat(64) }],
    });
    expect(() =>
      verifyPublishedRelease(
        publishedInput({ assets: publishedAssets({ [RELEASE_ATTESTATION_FILENAME]: missing }) }),
      ),
    ).toThrow("does not cover required asset");

    const stray = attestationWith({
      assets: [
        ...(publishedAttestation().assets as readonly unknown[]),
        { name: "stray.txt", sha256: "b".repeat(64) },
      ],
    });
    expect(() =>
      verifyPublishedRelease(
        publishedInput({ assets: publishedAssets({ [RELEASE_ATTESTATION_FILENAME]: stray }) }),
      ),
    ).toThrow('the attestation covers unexpected asset "stray.txt"');
  });

  it("rejects a published manifest that describes a different BOM than the attestation", () => {
    const otherCatalog = manifestJson().replace(CATALOG_COMMIT, "a".repeat(40));
    expect(() =>
      verifyPublishedRelease(
        publishedInput({ assets: publishedAssets({ [RELEASE_MANIFEST_ASSET]: otherCatalog }) }),
      ),
    ).toThrow("but the attestation binds");

    const otherVersion = manifestJson().replace(`"version": "${VERSION}"`, '"version": "1.5.0"');
    expect(() =>
      verifyPublishedRelease(
        publishedInput({ assets: publishedAssets({ [RELEASE_MANIFEST_ASSET]: otherVersion }) }),
      ),
    ).toThrow("the published manifest declares version");
  });

  it("rejects a hand-edited release report: it must regenerate from the manifest", () => {
    const assets = publishedAssets({
      [RELEASE_REPORT_ASSET]: "# TenkaCloud release 1.4.0\n\nCertified for production.\n",
    });
    expect(() => verifyPublishedRelease(publishedInput({ assets }))).toThrow(
      "is not what the published manifest generates",
    );
  });

  it("rejects an unversioned tarball that is not an alias of this release's tarball", () => {
    const assets = publishedAssets({ [UNVERSIONED_CLI_ASSET]: "some-other-tarball" });
    expect(() => verifyPublishedRelease(publishedInput({ assets }))).toThrow("are different bytes");
  });

  it("rejects a latest-download URL that serves a different tarball", () => {
    expect(() =>
      verifyPublishedRelease(publishedInput({ latestDownloadSha256: "f".repeat(64) })),
    ).toThrow("not this release's tarball");
  });

  it("rejects a launcher default pair that lags the published BOM", () => {
    for (const [defaults, message] of [
      [{ ...LAUNCHER_DEFAULTS, platformCommit: "a".repeat(40) }, "default RepoRef"],
      [{ ...LAUNCHER_DEFAULTS, catalogCommit: "a".repeat(40) }, "default ProblemsRepoRef"],
      [{ ...LAUNCHER_DEFAULTS, manifestVersion: "1.2.0-candidate.20260810" }, "manifest version"],
    ] as const) {
      expect(() => verifyPublishedRelease(publishedInput({ launcherDefaults: defaults }))).toThrow(
        message,
      );
    }
  });

  it("rejects assets that are not valid UTF-8 or valid JSON where the contract needs them", () => {
    const binary = publishedAssets().map((asset) =>
      asset.name === SHA256SUMS_FILENAME
        ? { ...asset, bytes: Uint8Array.from([0xff, 0xfe, 0xfd]) }
        : asset,
    );
    expect(() => verifyPublishedRelease(publishedInput({ assets: binary }))).toThrow(
      "is not valid UTF-8",
    );

    const notJson = publishedAssets({ [RELEASE_ATTESTATION_FILENAME]: "{ nope" });
    expect(() => verifyPublishedRelease(publishedInput({ assets: notJson }))).toThrow(
      "is not valid JSON",
    );
  });

  it("re-parses a published attestation with the same fail-closed vocabulary it was written under", () => {
    const attestation = publishedAttestation();
    expect(parseReleaseAttestation(attestation).tag).toBe(TAG);
    expect(() => parseReleaseAttestation({ ...attestation, extra: true })).toThrow(
      "unknown property",
    );
    expect(() => parseReleaseAttestation({ ...attestation, schemaVersion: 2 })).toThrow(
      "$.schemaVersion",
    );
    expect(() => parseReleaseAttestation({ ...attestation, platformCommit: "abc" })).toThrow(
      "lowercase full 40-hex platform commit",
    );
    expect(() => parseReleaseAttestation({ ...attestation, simulatorImage: "sim:latest" })).toThrow(
      "pinned by a lowercase sha256 digest",
    );
    expect(() => parseReleaseAttestation({ ...attestation, generatedAt: "yesterday" })).toThrow(
      "$.generatedAt",
    );
    expect(() =>
      parseReleaseAttestation({ ...attestation, assets: [{ name: "a", sha256: "short" }] }),
    ).toThrow("$.assets[0].sha256");
  });
});
