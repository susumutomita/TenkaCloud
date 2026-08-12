import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveReleaseIdentity } from "./identity";
import { parseReleaseManifest, type ReleaseManifest } from "./manifest";
import { parseVerifyIdentityArguments } from "./verify-release-identity";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "release/tenkacloud-release.json");

const TAG_COMMIT = "d".repeat(40);

function committedManifest(): ReleaseManifest {
  return parseReleaseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
}

function contextFor(manifest: ReleaseManifest) {
  return {
    tag: `v${manifest.release.version}`,
    tagCommit: TAG_COMMIT,
    catalogGitlink: manifest.sources.catalog.commit,
  };
}

describe("release identity resolution", () => {
  it("joins the committed manifest with a matching tag into one resolved identity", () => {
    const manifest = committedManifest();
    const identity = resolveReleaseIdentity(manifest, contextFor(manifest));
    expect(identity).toEqual({
      tag: `v${manifest.release.version}`,
      version: manifest.release.version,
      status: manifest.release.status,
      platformCommit: TAG_COMMIT,
      catalogCommit: manifest.sources.catalog.commit,
      simulatorImage: manifest.artifacts.simulatorImage,
      toolchain: manifest.toolchain,
    });
  });

  it.each([
    "1.4.0",
    "v1.4",
    "v1.4.0-rc.1",
    "v01.4.0",
    "release-1.4.0",
  ])("rejects non-stable tag %s", (tag) => {
    const manifest = committedManifest();
    expect(() => resolveReleaseIdentity(manifest, { ...contextFor(manifest), tag })).toThrow(
      "not a stable v<major>.<minor>.<patch> release tag",
    );
  });

  it("rejects a tag that does not match the manifest release version", () => {
    const manifest = committedManifest();
    expect(() =>
      resolveReleaseIdentity(manifest, { ...contextFor(manifest), tag: "v9.9.9" }),
    ).toThrow("does not match the manifest release version");
  });

  it.each([
    "main",
    "d".repeat(39),
    "D".repeat(40),
  ])("rejects tag commit %s that is not a full lowercase SHA", (tagCommit) => {
    const manifest = committedManifest();
    expect(() => resolveReleaseIdentity(manifest, { ...contextFor(manifest), tagCommit })).toThrow(
      "not a lowercase full 40-hex commit",
    );
  });

  it("rejects a tagged tree whose problems gitlink disagrees with the manifest catalog pin", () => {
    const manifest = committedManifest();
    expect(() =>
      resolveReleaseIdentity(manifest, {
        ...contextFor(manifest),
        catalogGitlink: "f".repeat(40),
      }),
    ).toThrow("does not match the manifest catalog commit");
  });

  it("rejects Golden Path evidence produced on a different platform commit", () => {
    const value = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      verification: { goldenPathRuns: unknown[] };
      release: { version: string };
      sources: { catalog: { commit: string } };
      artifacts: { simulatorImage: string };
      toolchain: unknown;
    };
    value.verification.goldenPathRuns = [
      {
        runId: "golden-1",
        mode: "lite",
        region: "ap-northeast-1",
        completedAt: "2026-08-01T00:00:00Z",
        result: "passed",
        evidenceUrl: "https://github.com/susumutomita/TenkaCloud/actions/runs/1",
        evidenceSha256: "1".padStart(64, "0"),
        bom: {
          releaseVersion: value.release.version,
          platformCommit: "b".repeat(40),
          catalogCommit: value.sources.catalog.commit,
          simulatorImage: value.artifacts.simulatorImage,
          toolchain: structuredClone(value.toolchain),
        },
        runner: {
          repository: "https://github.com/susumutomita/TenkaCloud.git",
          commit: "a".repeat(40),
        },
        freshEnvironment: {
          environmentId: "fresh-lite-1",
          decision: "passed",
          evidenceUrl: "https://evidence.tenkacloud.dev/fresh-environments/1",
          evidenceSha256: "65".padStart(64, "0"),
        },
        residualScan: {
          reportVersion: 1,
          runId: "golden-1",
          decision: "passed",
          evidenceUrl: "https://evidence.tenkacloud.dev/residual-scans/1",
          evidenceSha256: "c9".padStart(64, "0"),
        },
      },
    ];
    const manifest = parseReleaseManifest(value, { now: new Date("2026-08-10T00:00:00Z") });
    expect(() => resolveReleaseIdentity(manifest, contextFor(manifest))).toThrow(
      "its evidence cannot certify this release",
    );
  });
});

describe("verify-release-identity CLI arguments", () => {
  it("requires --tag with a value", () => {
    expect(() => parseVerifyIdentityArguments([])).toThrow("Usage:");
    expect(() => parseVerifyIdentityArguments(["--tag"])).toThrow("Usage:");
    expect(() => parseVerifyIdentityArguments(["--tag", "--json"])).toThrow("Usage:");
    expect(parseVerifyIdentityArguments(["--tag", "v1.4.0"])).toEqual({ tag: "v1.4.0" });
  });
});
