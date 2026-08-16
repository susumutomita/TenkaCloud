import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_ATTESTATION_FILENAME } from "./generate-release-attestation";
import {
  LATEST_DOWNLOAD_ASSET,
  type PublishedAsset,
  type PublishedReleaseEvidence,
  repositorySlug,
  SHA256SUMS_FILENAME,
  verifyPublishedRelease,
} from "./published-release";
import { readTaggedFile, resolveIdentityFromLocalTag } from "./verify-release-identity";

/**
 * Verifies the GitHub Release that a `v*` tag actually published (#3024 PR 5).
 *
 * The release workflow runs this after `gh release create`, so every published release
 * proves itself once, in the run that created it, instead of relying on a one-time manual
 * inspection. Anyone with a clone of the tag can repeat it: the only inputs are the tagged
 * tree and the bytes GitHub serves.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "tenkacloud-release-verification",
};
// GitHub asset names are attacker-influenced only by someone who can already push to this
// repository, but they are still used as file names below, so keep them to a shape that
// cannot escape the output directory.
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface VerifyPublishedArguments {
  readonly tag: string;
  /** Require `releases/latest/download/` to serve this release. The publish-time gate. */
  readonly requireLatest: boolean;
  /** Directory to write the verified asset bytes into, for a downstream install test. */
  readonly assetsOut: string | null;
  readonly evidenceOut: string | null;
}

const USAGE =
  "Usage: bun run scripts/release/verify-published-release.ts --tag v<major>.<minor>.<patch> " +
  "[--require-latest] [--assets-out <dir>] [--evidence-out <file>]";

function optionValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(USAGE);
  return value;
}

export function parseVerifyPublishedArguments(argv: readonly string[]): VerifyPublishedArguments {
  const tag = optionValue(argv, "--tag");
  if (tag === null) throw new Error(USAGE);
  return {
    tag,
    requireLatest: argv.includes("--require-latest"),
    assetsOut: optionValue(argv, "--assets-out"),
    evidenceOut: optionValue(argv, "--evidence-out"),
  };
}

export interface PublishedAssetSource {
  readonly name: string;
  readonly url: string;
}

export interface PublishedReleaseResponse {
  readonly htmlUrl: string;
  readonly assets: readonly PublishedAssetSource[];
}

/** Reads only what verification needs out of the release API response, rejecting anything unusable. */
export function parseReleaseResponse(value: unknown): PublishedReleaseResponse {
  const release = value as { html_url?: unknown; assets?: unknown };
  if (typeof release?.html_url !== "string" || !Array.isArray(release.assets)) {
    throw new Error("The GitHub release response has no html_url or assets array.");
  }
  const assets = release.assets.map((entry, index) => {
    const asset = entry as { name?: unknown; url?: unknown };
    if (typeof asset?.name !== "string" || typeof asset?.url !== "string") {
      throw new Error(`Release asset ${index} has no name or download url.`);
    }
    if (!SAFE_ASSET_NAME.test(asset.name)) {
      throw new Error(`Release asset name ${JSON.stringify(asset.name)} is not a plain file name.`);
    }
    return { name: asset.name, url: asset.url };
  });
  return { htmlUrl: release.html_url, assets };
}

export type FetchLike = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<Response>;

/**
 * Where the release bytes come from. Injected rather than reached for directly, so the
 * transport — auth headers, octet-stream downloads, the 404 that means "no releases yet" —
 * is exercised by tests instead of first running for real on a published release.
 */
export interface GithubAccess {
  readonly fetch: FetchLike;
  readonly token: string | null;
  readonly apiBase: string;
  readonly webBase: string;
}

export function githubAccessFromEnv(env: NodeJS.ProcessEnv): GithubAccess {
  return {
    fetch: (url, init) => fetch(url, init),
    token: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? null,
    apiBase: GITHUB_API,
    webBase: GITHUB_WEB,
  };
}

function authHeaders(access: GithubAccess, accept?: string): Record<string, string> {
  const headers: Record<string, string> = { ...API_HEADERS };
  if (access.token) headers.authorization = `Bearer ${access.token}`;
  if (accept) headers.accept = accept;
  return headers;
}

async function get(access: GithubAccess, url: string, accept?: string): Promise<Response> {
  const response = await access.fetch(url, { headers: authHeaders(access, accept) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolves the tag of the repository's latest release, or null when it has none. A 404
 * here is the documented "no releases yet" answer, not a transport failure.
 */
async function latestReleaseTag(access: GithubAccess, repository: string): Promise<string | null> {
  const url = `${access.apiBase}/repos/${repository}/releases/latest`;
  const response = await access.fetch(url, { headers: authHeaders(access) });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const latest = (await response.json()) as { tag_name?: unknown };
  return typeof latest?.tag_name === "string" ? latest.tag_name : null;
}

export interface FetchedRelease {
  readonly releaseUrl: string;
  /** Every attached asset, by name, as the bytes GitHub served. */
  readonly assets: ReadonlyMap<string, Buffer>;
  readonly latestReleaseTag: string | null;
  /** Bytes served by `releases/latest/download/`, fetched only when this tag owns that URL. */
  readonly latestDownload: Buffer | null;
}

export interface FetchPublishedOptions {
  /**
   * Extra attempts to see this tag own `releases/latest/download/`. The verify job runs
   * seconds after `gh release create`, and a release is only as verifiable as GitHub has
   * finished serving it — without a small budget here, a propagation lag would report a
   * perfectly good release as unverified, whose only remedy is recreating it. Zero when
   * re-verifying an older tag: there a newer release legitimately owns that URL and
   * waiting proves nothing.
   */
  readonly latestRetries?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function resolveLatestDownload(
  access: GithubAccess,
  repository: string,
  tag: string,
  options: FetchPublishedOptions,
): Promise<{ readonly tag: string | null; readonly bytes: Buffer | null }> {
  const retries = options.latestRetries ?? 0;
  const delayMs = options.retryDelayMs ?? 5000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `${access.webBase}/${repository}/releases/latest/download/${LATEST_DOWNLOAD_ASSET}`;
  for (let attempt = 0; ; attempt++) {
    const latest = await latestReleaseTag(access, repository);
    const lastAttempt = attempt >= retries;
    if (latest === tag) {
      try {
        return { tag: latest, bytes: Buffer.from(await (await get(access, url)).arrayBuffer()) };
      } catch (error) {
        if (lastAttempt) throw error;
      }
    } else if (lastAttempt) {
      return { tag: latest, bytes: null };
    }
    await sleep(delayMs);
  }
}

/** Downloads everything the verification needs: the release, its assets, and the latest-download URL. */
export async function fetchPublishedRelease(
  access: GithubAccess,
  repository: string,
  tag: string,
  options: FetchPublishedOptions = {},
): Promise<FetchedRelease> {
  const release = parseReleaseResponse(
    await (
      await get(
        access,
        `${access.apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      )
    ).json(),
  );
  const assets = new Map<string, Buffer>();
  for (const asset of release.assets) {
    const response = await get(access, asset.url, "application/octet-stream");
    assets.set(asset.name, Buffer.from(await response.arrayBuffer()));
  }
  const latest = await resolveLatestDownload(access, repository, tag, options);
  return {
    releaseUrl: release.htmlUrl,
    assets,
    latestReleaseTag: latest.tag,
    latestDownload: latest.bytes,
  };
}

function writeAssets(directory: string, bytes: ReadonlyMap<string, Buffer>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of bytes) {
    writeFileSync(join(directory, name), content);
  }
}

function reportToConsole(evidence: PublishedReleaseEvidence): void {
  for (const check of evidence.checks) {
    console.error(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
  }
  console.error(
    evidence.verified
      ? `\nVerified published release ${evidence.tag}: ${evidence.releaseUrl}`
      : `\nPublished release ${evidence.tag} FAILED verification: ${evidence.releaseUrl}`,
  );
}

async function main(): Promise<void> {
  const args = parseVerifyPublishedArguments(process.argv.slice(2));
  const { identity, manifest } = resolveIdentityFromLocalTag(args.tag);
  const repository = repositorySlug(manifest.sources.platform.repository);
  const access = githubAccessFromEnv(process.env);

  // Only the publish-time run waits for the latest-download URL to catch up; a
  // re-verification of an older tag has nothing to wait for.
  const released = await fetchPublishedRelease(access, repository, identity.tag, {
    latestRetries: args.requireLatest ? 3 : 0,
  });
  const bytes = released.assets;
  const assets: readonly PublishedAsset[] = [...bytes].map(([name, content]) => ({
    name,
    sha256: sha256(content),
  }));

  const evidence = verifyPublishedRelease({
    identity,
    repository,
    releaseUrl: released.releaseUrl,
    assets,
    sha256sums: bytes.get(SHA256SUMS_FILENAME)?.toString("utf8") ?? null,
    attestationJson: bytes.get(RELEASE_ATTESTATION_FILENAME)?.toString("utf8") ?? null,
    taggedTree: {
      manifestSha256: sha256(
        readTaggedFile(identity.platformCommit, "release/tenkacloud-release.json"),
      ),
      reportSha256: sha256(
        readTaggedFile(identity.platformCommit, "release/tenkacloud-release.md"),
      ),
    },
    latestDownload: {
      required: args.requireLatest,
      latestReleaseTag: released.latestReleaseTag,
      sha256: released.latestDownload === null ? null : sha256(released.latestDownload),
    },
    verifiedAt: new Date().toISOString(),
  });

  if (args.assetsOut !== null) writeAssets(args.assetsOut, bytes);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.evidenceOut !== null) writeFileSync(args.evidenceOut, serialized);
  console.log(serialized.trimEnd());
  reportToConsole(evidence);
  if (!evidence.verified) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
