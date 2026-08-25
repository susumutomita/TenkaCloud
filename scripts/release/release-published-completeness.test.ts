import { describe, expect, it } from "bun:test";
import {
  checkReleasePublishedCompleteness,
  parseReleasePublishedEvent,
  type ReleasePublishedEvent,
} from "./release-published-completeness";

const VERSION = "1.3.1";
const TAG = `v${VERSION}`;

const REQUIRED_ASSETS = [
  `tenkacloud-cli-${VERSION}.tgz`,
  "tenkacloud-cli.tgz",
  "release-manifest.json",
  "release-report.md",
  "SHA256SUMS",
  "release-attestation.json",
] as const;

function event(overrides: Partial<ReleasePublishedEvent> = {}): ReleasePublishedEvent {
  return {
    tagName: TAG,
    draft: false,
    prerelease: false,
    assetNames: [...REQUIRED_ASSETS],
    ...overrides,
  };
}

describe("checkReleasePublishedCompleteness", () => {
  // The actual bug: v1.2.1 and v1.3.1 are both real, published, non-draft, non-prerelease
  // Releases with an empty asset list. A guard that treats "nothing to compare against" as
  // a pass would never have caught either of them. This test pins that it does not.
  it("FAILS a published release with zero assets, rather than passing vacuously", () => {
    const result = checkReleasePublishedCompleteness(event({ assetNames: [] }));
    expect(result.inScope).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.missingAssets).toEqual([...REQUIRED_ASSETS]);
    expect(result.summary).toContain("missing 6 of 6 required assets");
  });

  it("FAILS a release missing only the stable-name tarball (the versioned/stable pair)", () => {
    const result = checkReleasePublishedCompleteness(
      event({ assetNames: REQUIRED_ASSETS.filter((name) => name !== "tenkacloud-cli.tgz") }),
    );
    expect(result.passed).toBe(false);
    expect(result.missingAssets).toEqual(["tenkacloud-cli.tgz"]);
  });

  it("FAILS a release missing only the versioned tarball", () => {
    const result = checkReleasePublishedCompleteness(
      event({
        assetNames: REQUIRED_ASSETS.filter((name) => name !== `tenkacloud-cli-${VERSION}.tgz`),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.missingAssets).toEqual([`tenkacloud-cli-${VERSION}.tgz`]);
  });

  it("FAILS a partial release missing the attestation and checksums", () => {
    const result = checkReleasePublishedCompleteness(
      event({
        assetNames: [
          `tenkacloud-cli-${VERSION}.tgz`,
          "tenkacloud-cli.tgz",
          "release-manifest.json",
          "release-report.md",
        ],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.missingAssets).toEqual(["SHA256SUMS", "release-attestation.json"]);
  });

  it("PASSES a release carrying exactly the required six-asset set", () => {
    const result = checkReleasePublishedCompleteness(event());
    expect(result.inScope).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.missingAssets).toEqual([]);
    expect(result.requiredAssets).toEqual([...REQUIRED_ASSETS]);
  });

  it("PASSES, noting but not failing on, a release carrying an extra unexpected asset", () => {
    const result = checkReleasePublishedCompleteness(
      event({ assetNames: [...REQUIRED_ASSETS, "some-extra-file.txt"] }),
    );
    expect(result.passed).toBe(true);
    expect(result.unexpectedAssets).toEqual(["some-extra-file.txt"]);
  });

  it("skips a draft release without failing it", () => {
    const result = checkReleasePublishedCompleteness(event({ draft: true, assetNames: [] }));
    expect(result.inScope).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.scopeReason).toContain("draft");
  });

  it("skips a prerelease without failing it", () => {
    const result = checkReleasePublishedCompleteness(event({ prerelease: true, assetNames: [] }));
    expect(result.inScope).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.scopeReason).toContain("prerelease");
  });

  it("skips a non-v* tag without failing it", () => {
    const result = checkReleasePublishedCompleteness(
      event({ tagName: "cli-tools-v1", assetNames: [] }),
    );
    expect(result.inScope).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.scopeReason).toContain("not a v*-tagged release");
  });

  it("FAILS, rather than skips, a v*-tagged release whose tag is not a stable version", () => {
    const result = checkReleasePublishedCompleteness(
      event({ tagName: "v1.3.1-rc1", assetNames: [] }),
    );
    expect(result.inScope).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("does not match the v<major>.<minor>.<patch> shape");
  });

  it("derives the versioned tarball name from the tag, not a hardcoded version", () => {
    const result = checkReleasePublishedCompleteness(
      event({ tagName: "v9.9.9", assetNames: ["tenkacloud-cli-9.9.9.tgz"] }),
    );
    expect(result.requiredAssets).toContain("tenkacloud-cli-9.9.9.tgz");
    expect(result.missingAssets).not.toContain("tenkacloud-cli-9.9.9.tgz");
  });
});

describe("parseReleasePublishedEvent", () => {
  function payload(overrides: Record<string, unknown> = {}) {
    return {
      release: {
        tag_name: TAG,
        draft: false,
        prerelease: false,
        assets: REQUIRED_ASSETS.map((name) => ({ name })),
        ...overrides,
      },
    };
  }

  it("reads the fields this guard needs out of a release webhook payload", () => {
    const parsed = parseReleasePublishedEvent(payload());
    expect(parsed).toEqual({
      tagName: TAG,
      draft: false,
      prerelease: false,
      assetNames: [...REQUIRED_ASSETS],
    });
  });

  it("reads a real empty asset list as an empty array, not a missing field", () => {
    const parsed = parseReleasePublishedEvent(payload({ assets: [] }));
    expect(parsed.assetNames).toEqual([]);
  });

  it("rejects a payload with no release object", () => {
    expect(() => parseReleasePublishedEvent({})).toThrow(/\$\.release/);
  });

  it("rejects a release with a non-string tag_name", () => {
    expect(() => parseReleasePublishedEvent(payload({ tag_name: null }))).toThrow(
      /\$\.release\.tag_name/,
    );
  });

  it("rejects a release whose assets are not an array", () => {
    expect(() => parseReleasePublishedEvent(payload({ assets: "none" }))).toThrow(
      /\$\.release\.assets/,
    );
  });

  it("rejects an asset entry with no name", () => {
    expect(() => parseReleasePublishedEvent(payload({ assets: [{}] }))).toThrow(
      /\$\.release\.assets\[0\]\.name/,
    );
  });
});
