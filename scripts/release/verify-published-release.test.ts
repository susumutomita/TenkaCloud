import { describe, expect, it } from "bun:test";
import {
  type DownloadedAsset,
  publishedReleaseAssetNames,
  UNVERSIONED_CLI_ASSET,
  verifyPublishedRelease,
} from "./published-release";
import {
  LAUNCHER_DEFAULTS,
  PLATFORM_COMMIT,
  publishedAssets,
  TAG,
  VERIFIED_AT,
  VERSION,
} from "./published-release.fixtures";
import {
  collectPublishedRelease,
  parseReleaseAssetIndex,
  parseTagCommit,
  parseVerifyPublishedArguments,
  type ReleaseFetcher,
} from "./verify-published-release";

describe("published release collection", () => {
  it("reads the asset index and refuses drafts and malformed responses", () => {
    expect(
      parseReleaseAssetIndex({
        draft: false,
        assets: [{ name: "a.tgz", browser_download_url: "https://example.invalid/a.tgz" }],
      }),
    ).toEqual([{ name: "a.tgz", url: "https://example.invalid/a.tgz" }]);
    expect(() => parseReleaseAssetIndex({ draft: true, assets: [] })).toThrow("still a draft");
    expect(() => parseReleaseAssetIndex({ assets: {} })).toThrow("no asset list");
    expect(() => parseReleaseAssetIndex([])).toThrow("did not return a release object");
    expect(() => parseReleaseAssetIndex({ assets: [null] })).toThrow("is not an object");
    expect(() => parseReleaseAssetIndex({ assets: [{ name: "" }] })).toThrow("has no name");
    expect(() =>
      parseReleaseAssetIndex({
        // The cleartext URL is the input under test: the verifier must refuse to download over it.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- asserting rejection
        assets: [{ name: "a.tgz", browser_download_url: "http://example.invalid/a.tgz" }],
      }),
    ).toThrow("has no HTTPS download URL");
  });

  it("resolves the tag to a commit through the forge, not the manifest", () => {
    expect(parseTagCommit({ sha: PLATFORM_COMMIT })).toBe(PLATFORM_COMMIT);
    expect(() => parseTagCommit({ sha: "v1.4.0" })).toThrow("full 40-hex commit");
    expect(() => parseTagCommit("nope")).toThrow("did not return a commit object");
  });

  it("downloads every published asset plus the latest-download tarball", async () => {
    const assets = publishedAssets();
    const requested: string[] = [];
    const fetcher: ReleaseFetcher = {
      async json(url) {
        requested.push(url);
        if (url.endsWith(`/commits/${TAG}`)) return { sha: PLATFORM_COMMIT };
        return {
          draft: false,
          assets: assets.map(({ name }) => ({
            name,
            browser_download_url: `https://example.invalid/${name}`,
          })),
        };
      },
      async bytes(url) {
        requested.push(url);
        const name = url.split("/").pop() as string;
        return (assets.find((asset) => asset.name === name) as DownloadedAsset).bytes;
      },
    };
    const collected = await collectPublishedRelease({
      repository: "susumutomita/TenkaCloud",
      tag: TAG,
      fetcher,
      launcherDefaults: LAUNCHER_DEFAULTS,
      verifiedAt: VERIFIED_AT,
    });
    expect(collected.tagCommit).toBe(PLATFORM_COMMIT);
    expect(collected.assets.map(({ name }) => name).sort()).toEqual(
      [...publishedReleaseAssetNames(VERSION)].sort(),
    );
    expect(requested).toContain(
      `https://github.com/susumutomita/TenkaCloud/releases/latest/download/${UNVERSIONED_CLI_ASSET}`,
    );
    // The collected shape is what the contract actually verifies, not just a download list.
    expect(verifyPublishedRelease(collected).tag).toBe(TAG);
  });

  it("parses its arguments and defaults the repository slug", () => {
    expect(parseVerifyPublishedArguments(["--tag", TAG])).toEqual({
      repository: "susumutomita/TenkaCloud",
      tag: TAG,
      out: undefined,
    });
    expect(
      parseVerifyPublishedArguments(["--tag", TAG, "--repo", "acme/fork", "--out", "e.json"]),
    ).toEqual({ repository: "acme/fork", tag: TAG, out: "e.json" });
    expect(() => parseVerifyPublishedArguments([])).toThrow("Usage:");
    expect(() => parseVerifyPublishedArguments(["--tag", "--out", "e.json"])).toThrow("Usage:");
    expect(() => parseVerifyPublishedArguments(["--tag", TAG, "--repo", "no-slash"])).toThrow(
      "is not an <owner>/<name> slug",
    );
  });
});
