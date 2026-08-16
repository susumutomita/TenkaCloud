import { describe, expect, it } from "bun:test";
import type { ReleaseIdentity } from "./identity";
import { readReleaseManifest } from "./manifest";
import {
  type PublishedReleaseInput,
  repositorySlug,
  verifyPublishedRelease,
} from "./published-release";
import {
  fetchPublishedRelease,
  type GithubAccess,
  parseReleaseResponse,
  parseVerifyPublishedArguments,
} from "./verify-published-release";

const manifest = readReleaseManifest();
const VERSION = manifest.release.version;
const TAG = `v${VERSION}`;
const REPOSITORY = "susumutomita/TenkaCloud";
const PLATFORM_COMMIT = "d".repeat(40);

const IDENTITY: ReleaseIdentity = {
  tag: TAG,
  version: VERSION,
  status: manifest.release.status,
  platformCommit: PLATFORM_COMMIT,
  catalogCommit: manifest.sources.catalog.commit,
  simulatorImage: manifest.artifacts.simulatorImage,
  toolchain: manifest.toolchain,
};

const DIGESTS = {
  cli: "1".repeat(64),
  manifest: "2".repeat(64),
  report: "3".repeat(64),
  sums: "4".repeat(64),
  attestation: "5".repeat(64),
} as const;

const HASHED_ASSETS = [
  { name: `tenkacloud-cli-${VERSION}.tgz`, sha256: DIGESTS.cli },
  { name: "tenkacloud-cli.tgz", sha256: DIGESTS.cli },
  { name: "release-manifest.json", sha256: DIGESTS.manifest },
  { name: "release-report.md", sha256: DIGESTS.report },
] as const;

function sha256sums(assets: readonly { name: string; sha256: string }[] = HASHED_ASSETS): string {
  const lines = assets.map((asset) => `${asset.sha256}  ${asset.name}`);
  return `${lines.join("\n")}\n`;
}

function attestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    tag: TAG,
    version: VERSION,
    status: IDENTITY.status,
    platformCommit: PLATFORM_COMMIT,
    catalogCommit: IDENTITY.catalogCommit,
    simulatorImage: IDENTITY.simulatorImage,
    manifestSha256: DIGESTS.manifest,
    assets: HASHED_ASSETS,
    workflow: {
      repository: REPOSITORY,
      runId: "123",
      runAttempt: "1",
      workflowRef: `${REPOSITORY}/.github/workflows/release-cli.yml@refs/tags/${TAG}`,
    },
    generatedAt: "2026-08-16T00:00:00Z",
    ...overrides,
  });
}

function publishedRelease(overrides: Partial<PublishedReleaseInput> = {}): PublishedReleaseInput {
  return {
    identity: IDENTITY,
    repository: REPOSITORY,
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
    assets: [
      ...HASHED_ASSETS,
      { name: "SHA256SUMS", sha256: DIGESTS.sums },
      { name: "release-attestation.json", sha256: DIGESTS.attestation },
    ],
    sha256sums: sha256sums(),
    attestationJson: attestation(),
    taggedTree: { manifestSha256: DIGESTS.manifest, reportSha256: DIGESTS.report },
    latestDownload: { required: true, latestReleaseTag: TAG, sha256: DIGESTS.cli },
    verifiedAt: "2026-08-16T01:00:00Z",
    ...overrides,
  };
}

function failedCheckIds(input: PublishedReleaseInput): string[] {
  return verifyPublishedRelease(input)
    .checks.filter((check) => !check.passed)
    .map((check) => check.id);
}

describe("published release verification", () => {
  it("verifies a release whose assets, checksums, attestation, and latest download all agree", () => {
    const evidence = verifyPublishedRelease(publishedRelease());
    expect(failedCheckIds(publishedRelease())).toEqual([]);
    expect(evidence.verified).toBe(true);
    expect(evidence.tag).toBe(TAG);
    expect(evidence.identity).toEqual(IDENTITY);
    expect(evidence.workflow?.runId).toBe("123");
    expect(evidence.assets.map((asset) => asset.name)).toEqual([
      "SHA256SUMS",
      "release-attestation.json",
      "release-manifest.json",
      "release-report.md",
      `tenkacloud-cli-${VERSION}.tgz`,
      "tenkacloud-cli.tgz",
    ]);
  });

  it("rejects a release that is missing a required asset", () => {
    const input = publishedRelease({
      assets: publishedRelease().assets.filter((asset) => asset.name !== "release-report.md"),
    });
    expect(failedCheckIds(input)).toContain("release-assets-complete");
    expect(verifyPublishedRelease(input).checks[0]?.detail).toContain(
      'missing "release-report.md"',
    );
  });

  it("rejects a release carrying an asset outside the closed set", () => {
    const input = publishedRelease({
      assets: [...publishedRelease().assets, { name: "extra.txt", sha256: "6".repeat(64) }],
    });
    expect(failedCheckIds(input)).toContain("release-assets-complete");
  });

  it("rejects SHA256SUMS that hashes something other than the four artifacts", () => {
    const input = publishedRelease({
      sha256sums: sha256sums([...HASHED_ASSETS, { name: "extra.txt", sha256: "6".repeat(64) }]),
    });
    expect(failedCheckIds(input)).toContain("sha256sums-cover-hashed-assets");
  });

  it("rejects a downloaded asset whose bytes disagree with SHA256SUMS", () => {
    const input = publishedRelease({
      assets: publishedRelease().assets.map((asset) =>
        asset.name === "release-report.md" ? { ...asset, sha256: "9".repeat(64) } : asset,
      ),
      taggedTree: { manifestSha256: DIGESTS.manifest, reportSha256: "9".repeat(64) },
    });
    expect(failedCheckIds(input)).toContain("published-bytes-match-sha256sums");
  });

  it("rejects an unversioned tarball that is not a copy of the versioned one", () => {
    const swapped = [
      { name: "tenkacloud-cli.tgz", sha256: "7".repeat(64) },
      ...HASHED_ASSETS,
    ].filter((asset, index, all) => all.findIndex((other) => other.name === asset.name) === index);
    const input = publishedRelease({
      assets: [
        ...swapped,
        { name: "SHA256SUMS", sha256: DIGESTS.sums },
        { name: "release-attestation.json", sha256: DIGESTS.attestation },
      ],
      sha256sums: sha256sums(swapped),
      attestationJson: attestation({ assets: swapped }),
    });
    expect(failedCheckIds(input)).toContain("unversioned-tarball-copies-the-versioned-one");
  });

  it("rejects published documents that differ from the tagged tree", () => {
    const input = publishedRelease({
      taggedTree: { manifestSha256: "8".repeat(64), reportSha256: DIGESTS.report },
    });
    expect(failedCheckIds(input)).toContain("published-documents-match-the-tagged-tree");
  });

  it("fails every attestation check when the attestation asset is absent", () => {
    expect(failedCheckIds(publishedRelease({ attestationJson: null }))).toEqual([
      "attestation-matches-tag-identity",
      "attestation-matches-published-assets",
      "attestation-names-the-release-workflow-run",
    ]);
  });

  it("fails every attestation check when the attestation is not parseable JSON", () => {
    const evidence = verifyPublishedRelease(publishedRelease({ attestationJson: "not json" }));
    expect(evidence.verified).toBe(false);
    expect(evidence.workflow).toBeNull();
    expect(
      evidence.checks.find((check) => check.id === "attestation-matches-tag-identity")?.detail,
    ).toContain("release-attestation.json is unusable");
  });

  it.each([
    ["platformCommit", { platformCommit: "e".repeat(40) }],
    ["catalogCommit", { catalogCommit: "f".repeat(40) }],
    ["tag", { tag: "v9.9.9", version: "9.9.9" }],
    ["status", { status: "certified" }],
  ])("rejects an attestation whose %s disagrees with the tag", (_field, overrides) => {
    const input = publishedRelease({ attestationJson: attestation(overrides) });
    expect(failedCheckIds(input)).toContain("attestation-matches-tag-identity");
  });

  it("rejects an attestation whose asset digests disagree with SHA256SUMS", () => {
    const input = publishedRelease({
      attestationJson: attestation({
        assets: HASHED_ASSETS.map((asset) =>
          asset.name === "release-manifest.json" ? { ...asset, sha256: "b".repeat(64) } : asset,
        ),
      }),
    });
    expect(failedCheckIds(input)).toContain("attestation-matches-published-assets");
  });

  it("rejects an attestation whose manifest digest is not the published manifest", () => {
    const input = publishedRelease({
      attestationJson: attestation({ manifestSha256: "c".repeat(64) }),
    });
    expect(failedCheckIds(input)).toContain("attestation-matches-published-assets");
  });

  it.each([
    ["another repository", { repository: "attacker/TenkaCloud" }],
    ["another workflow", { workflowRef: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` }],
  ])("rejects an attestation produced by %s", (_case, workflowOverrides) => {
    const workflow = JSON.parse(attestation()) as { workflow: Record<string, unknown> };
    const input = publishedRelease({
      attestationJson: attestation({ workflow: { ...workflow.workflow, ...workflowOverrides } }),
    });
    expect(failedCheckIds(input)).toContain("attestation-names-the-release-workflow-run");
  });

  it("accepts a workflow_dispatch backfill, which runs from a branch ref", () => {
    const workflow = JSON.parse(attestation()) as { workflow: Record<string, unknown> };
    const input = publishedRelease({
      attestationJson: attestation({
        workflow: {
          ...workflow.workflow,
          workflowRef: `${REPOSITORY}/.github/workflows/release-cli.yml@refs/heads/main`,
        },
      }),
    });
    expect(failedCheckIds(input)).toEqual([]);
  });

  it("rejects a latest-download URL that serves a different release when it must serve this one", () => {
    const input = publishedRelease({
      latestDownload: { required: true, latestReleaseTag: "v9.9.9", sha256: null },
    });
    expect(failedCheckIds(input)).toContain("latest-download-serves-this-release");
  });

  it("records the latest-download check as not applicable when an older tag is re-verified", () => {
    const input = publishedRelease({
      latestDownload: { required: false, latestReleaseTag: "v9.9.9", sha256: null },
    });
    const check = verifyPublishedRelease(input).checks.find(
      (candidate) => candidate.id === "latest-download-serves-this-release",
    );
    expect(check?.passed).toBe(true);
    expect(check?.detail).toStartWith("Not applicable:");
  });

  it("rejects a latest-download URL serving bytes this release did not publish", () => {
    const input = publishedRelease({
      latestDownload: { required: true, latestReleaseTag: TAG, sha256: "a".repeat(64) },
    });
    expect(failedCheckIds(input)).toContain("latest-download-serves-this-release");
  });

  it("rejects a latest-download URL that is not retrievable", () => {
    const input = publishedRelease({
      latestDownload: { required: true, latestReleaseTag: TAG, sha256: null },
    });
    expect(failedCheckIds(input)).toContain("latest-download-serves-this-release");
  });
});

describe("release repository slug", () => {
  it("derives the owner/name GitHub uses from the manifest repository URL", () => {
    expect(repositorySlug(manifest.sources.platform.repository)).toBe(REPOSITORY);
    expect(repositorySlug("https://github.com/susumutomita/TenkaCloudChallenge")).toBe(
      "susumutomita/TenkaCloudChallenge",
    );
  });

  it.each([
    "https://github.com/susumutomita",
    "https://github.com/susumutomita/TenkaCloud/tree/main",
  ])("rejects %s, which is not an owner/name repository URL", (url) => {
    expect(() => repositorySlug(url)).toThrow("Cannot derive an owner/name slug");
  });
});

describe("verify-published-release CLI", () => {
  it("requires --tag with a value", () => {
    expect(() => parseVerifyPublishedArguments([])).toThrow("Usage:");
    expect(() => parseVerifyPublishedArguments(["--tag"])).toThrow("Usage:");
    expect(() => parseVerifyPublishedArguments(["--tag", "--require-latest"])).toThrow("Usage:");
  });

  it("parses the release-time invocation", () => {
    expect(
      parseVerifyPublishedArguments([
        "--tag",
        TAG,
        "--require-latest",
        "--assets-out",
        "artifacts/published-assets",
        "--evidence-out",
        "artifacts/evidence.json",
      ]),
    ).toEqual({
      tag: TAG,
      requireLatest: true,
      assetsOut: "artifacts/published-assets",
      evidenceOut: "artifacts/evidence.json",
    });
  });

  it("defaults to a re-verification that neither writes files nor requires the latest release", () => {
    expect(parseVerifyPublishedArguments(["--tag", TAG])).toEqual({
      tag: TAG,
      requireLatest: false,
      assetsOut: null,
      evidenceOut: null,
    });
  });

  it("reads the asset names and download URLs out of a release API response", () => {
    expect(
      parseReleaseResponse({
        html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
        assets: [{ name: "SHA256SUMS", url: "https://api.github.com/assets/1", extra: "ignored" }],
      }),
    ).toEqual({
      htmlUrl: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
      assets: [{ name: "SHA256SUMS", url: "https://api.github.com/assets/1" }],
    });
  });

  it.each([
    [{ assets: [] }, "no html_url or assets array"],
    [{ html_url: "https://example.test", assets: {} }, "no html_url or assets array"],
    [
      { html_url: "https://example.test", assets: [{ name: "SHA256SUMS" }] },
      "no name or download url",
    ],
    [
      {
        html_url: "https://example.test",
        assets: [{ name: "../../escape.tgz", url: "https://api.github.com/assets/1" }],
      },
      "is not a plain file name",
    ],
  ])("rejects an unusable release response (%#)", (response, message) => {
    expect(() => parseReleaseResponse(response)).toThrow(message as string);
  });
});

// The transport only ever runs against real GitHub, so a stub `fetch` is the one place its
// auth headers, octet-stream downloads, and 404 handling can be exercised before a release
// depends on them.
describe("fetching a published release", () => {
  const API = "https://api.test";
  const WEB = "https://web.test";

  interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  function accessReturning(
    routes: Record<string, { status?: number; body?: unknown; bytes?: string }>,
    calls: Call[] = [],
    token: string | null = "secret-token",
  ): GithubAccess {
    return {
      token,
      apiBase: API,
      webBase: WEB,
      fetch: (url, init) => {
        calls.push({ url, headers: init.headers });
        const route = routes[url];
        if (!route) return Promise.resolve(new Response("", { status: 404 }));
        const status = route.status ?? 200;
        const body = route.bytes ?? JSON.stringify(route.body ?? {});
        return Promise.resolve(new Response(body, { status, statusText: `status ${status}` }));
      },
    };
  }

  function releaseRoutes(
    latestTag: string | null,
  ): Record<string, { body?: unknown; bytes?: string; status?: number }> {
    const routes: Record<string, { body?: unknown; bytes?: string; status?: number }> = {
      [`${API}/repos/${REPOSITORY}/releases/tags/${TAG}`]: {
        body: {
          html_url: `${WEB}/${REPOSITORY}/releases/tag/${TAG}`,
          assets: [{ name: "SHA256SUMS", url: `${API}/assets/1` }],
        },
      },
      [`${API}/assets/1`]: { bytes: "sums-bytes" },
      [`${API}/repos/${REPOSITORY}/releases/latest`]: latestTag
        ? { body: { tag_name: latestTag } }
        : { status: 404 },
      [`${WEB}/${REPOSITORY}/releases/latest/download/tenkacloud-cli.tgz`]: { bytes: "cli-bytes" },
    };
    return routes;
  }

  it("downloads every asset with the token, and the latest-download URL this tag owns", async () => {
    const calls: Call[] = [];
    const released = await fetchPublishedRelease(
      accessReturning(releaseRoutes(TAG), calls),
      REPOSITORY,
      TAG,
    );
    expect(released.releaseUrl).toBe(`${WEB}/${REPOSITORY}/releases/tag/${TAG}`);
    expect(released.assets.get("SHA256SUMS")?.toString("utf8")).toBe("sums-bytes");
    expect(released.latestReleaseTag).toBe(TAG);
    expect(released.latestDownload?.toString("utf8")).toBe("cli-bytes");
    expect(calls.every((call) => call.headers.authorization === "Bearer secret-token")).toBe(true);
    expect(calls.find((call) => call.url === `${API}/assets/1`)?.headers.accept).toBe(
      "application/octet-stream",
    );
  });

  it("skips the latest-download fetch when a newer release owns that URL", async () => {
    const calls: Call[] = [];
    const released = await fetchPublishedRelease(
      accessReturning(releaseRoutes("v9.9.9"), calls),
      REPOSITORY,
      TAG,
    );
    expect(released.latestReleaseTag).toBe("v9.9.9");
    expect(released.latestDownload).toBeNull();
    expect(calls.some((call) => call.url.includes("/releases/latest/download/"))).toBe(false);
  });

  it("treats a 404 from the latest-release endpoint as 'no releases yet', not a failure", async () => {
    const released = await fetchPublishedRelease(
      accessReturning(releaseRoutes(null)),
      REPOSITORY,
      TAG,
    );
    expect(released.latestReleaseTag).toBeNull();
    expect(released.latestDownload).toBeNull();
  });

  it("omits the authorization header when no token is available", async () => {
    const calls: Call[] = [];
    await fetchPublishedRelease(accessReturning(releaseRoutes(TAG), calls, null), REPOSITORY, TAG);
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
  });

  it("fails loudly when the release, an asset, or the latest download is not retrievable", async () => {
    const routes = releaseRoutes(TAG);
    await expect(fetchPublishedRelease(accessReturning({}), REPOSITORY, TAG)).rejects.toThrow(
      `GET ${API}/repos/${REPOSITORY}/releases/tags/${TAG} failed: 404`,
    );
    await expect(
      fetchPublishedRelease(
        accessReturning({ ...routes, [`${API}/assets/1`]: { status: 500 } }),
        REPOSITORY,
        TAG,
      ),
    ).rejects.toThrow(`GET ${API}/assets/1 failed: 500`);
    await expect(
      fetchPublishedRelease(
        accessReturning({
          ...routes,
          [`${WEB}/${REPOSITORY}/releases/latest/download/tenkacloud-cli.tgz`]: { status: 502 },
        }),
        REPOSITORY,
        TAG,
      ),
    ).rejects.toThrow("failed: 502");
    await expect(
      fetchPublishedRelease(
        accessReturning({
          ...routes,
          [`${API}/repos/${REPOSITORY}/releases/latest`]: { status: 500 },
        }),
        REPOSITORY,
        TAG,
      ),
    ).rejects.toThrow(`GET ${API}/repos/${REPOSITORY}/releases/latest failed: 500`);
  });
});

// Publication is not instantaneous: the verify job runs seconds after `gh release create`,
// and reporting a good release as unverified would cost a recreated release.
describe("waiting for the latest-download URL to catch up", () => {
  const API = "https://api.test";
  const WEB = "https://web.test";

  function accessServingLatest(latestTags: string[], downloadStatuses: number[]): GithubAccess {
    let latestCall = 0;
    let downloadCall = 0;
    return {
      token: null,
      apiBase: API,
      webBase: WEB,
      fetch: (url) => {
        if (url === `${API}/repos/${REPOSITORY}/releases/tags/${TAG}`) {
          return Promise.resolve(
            new Response(JSON.stringify({ html_url: `${WEB}/r`, assets: [] }), { status: 200 }),
          );
        }
        if (url === `${API}/repos/${REPOSITORY}/releases/latest`) {
          const tag = latestTags[Math.min(latestCall++, latestTags.length - 1)];
          return Promise.resolve(new Response(JSON.stringify({ tag_name: tag }), { status: 200 }));
        }
        const status =
          downloadStatuses[Math.min(downloadCall++, downloadStatuses.length - 1)] ?? 200;
        return Promise.resolve(
          new Response("cli-bytes", { status, statusText: `status ${status}` }),
        );
      },
    };
  }

  const noWait = { retryDelayMs: 0, sleep: () => Promise.resolve() };

  it("retries until this tag owns the latest-download URL", async () => {
    const released = await fetchPublishedRelease(
      accessServingLatest(["v1.0.0", "v1.0.0", TAG], [200]),
      REPOSITORY,
      TAG,
      { latestRetries: 3, ...noWait },
    );
    expect(released.latestReleaseTag).toBe(TAG);
    expect(released.latestDownload?.toString("utf8")).toBe("cli-bytes");
  });

  it("retries a latest-download URL that is not serving the asset yet", async () => {
    const released = await fetchPublishedRelease(
      accessServingLatest([TAG], [404, 200]),
      REPOSITORY,
      TAG,
      { latestRetries: 3, ...noWait },
    );
    expect(released.latestDownload?.toString("utf8")).toBe("cli-bytes");
  });

  it("reports the other tag once the retry budget is spent, instead of waiting forever", async () => {
    const released = await fetchPublishedRelease(
      accessServingLatest(["v9.9.9"], [200]),
      REPOSITORY,
      TAG,
      { latestRetries: 2, ...noWait },
    );
    expect(released.latestReleaseTag).toBe("v9.9.9");
    expect(released.latestDownload).toBeNull();
  });

  it("surfaces a latest-download failure that outlives the retry budget", async () => {
    await expect(
      fetchPublishedRelease(accessServingLatest([TAG], [503]), REPOSITORY, TAG, {
        latestRetries: 1,
        ...noWait,
      }),
    ).rejects.toThrow("failed: 503");
  });

  it("does not retry at all when no budget is given", async () => {
    const released = await fetchPublishedRelease(
      accessServingLatest(["v9.9.9", TAG], [200]),
      REPOSITORY,
      TAG,
    );
    expect(released.latestReleaseTag).toBe("v9.9.9");
    expect(released.latestDownload).toBeNull();
  });
});
