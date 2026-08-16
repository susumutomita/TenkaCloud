import { writeFileSync } from "node:fs";
import { type LauncherDefaults, readLauncherDefaults } from "./generate-launcher-defaults";
import { FULL_COMMIT } from "./manifest";
import {
  type DownloadedAsset,
  fail,
  type PublishedReleaseInput,
  sha256,
  UNVERSIONED_CLI_ASSET,
  verifyPublishedRelease,
} from "./published-release";

/**
 * Collects an already-published GitHub Release and verifies it end to end (#3024 PR 5).
 *
 * Every other release gate in this repository runs BEFORE publication and reads the working
 * tree. This one runs after, reads only what the Release actually serves to a third party,
 * and answers the question the issue exists to make answerable: does one tag resolve to
 * exactly one BOM everywhere a user can observe it?
 *
 * The chain it closes, entirely from downloaded bytes plus the forge's own tag→commit answer:
 *
 *   tag → commit → attestation → SHA256SUMS → asset bytes → manifest → report
 *                                                              ↓
 *                                                    launcher default pair
 *
 * The rules live in `published-release.ts`; this module owns only the network shapes and the
 * command line. Nothing here trusts the tag name, and nothing trusts the checked-in tree
 * except the launcher binding the verification is asserting about.
 *
 *   make release-verify-published TAG=v1.4.0
 */

/** One published Release asset as the GitHub releases API describes it. */
export interface ReleaseAssetRef {
  readonly name: string;
  readonly url: string;
}

/**
 * Reads the asset index out of a `GET /repos/{repo}/releases/tags/{tag}` response. Drafts are
 * rejected outright: a draft Release is mutable and invisible to third parties, so verifying
 * one would attest to something no user can download.
 */
export function parseReleaseAssetIndex(value: unknown): readonly ReleaseAssetRef[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("the releases API did not return a release object");
  }
  const release = value as Record<string, unknown>;
  if (release.draft === true) fail("the release is still a draft; drafts are mutable");
  if (!Array.isArray(release.assets)) fail("the releases API response has no asset list");
  return release.assets.map((asset, index) => {
    if (typeof asset !== "object" || asset === null) {
      fail(`asset ${index} in the releases API response is not an object`);
    }
    const entry = asset as Record<string, unknown>;
    const name = entry.name;
    const url = entry.browser_download_url;
    if (typeof name !== "string" || name.length === 0) {
      fail(`asset ${index} in the releases API response has no name`);
    }
    if (typeof url !== "string" || !url.startsWith("https://")) {
      fail(`published asset ${JSON.stringify(name)} has no HTTPS download URL`);
    }
    return { name, url };
  });
}

/** Reads the resolved commit out of a `GET /repos/{repo}/commits/{tag}` response. */
export function parseTagCommit(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("the commits API did not return a commit object");
  }
  const sha = (value as Record<string, unknown>).sha;
  if (typeof sha !== "string" || !FULL_COMMIT.test(sha)) {
    fail("the commits API did not resolve the tag to a full 40-hex commit");
  }
  return sha;
}

export interface VerifyPublishedArguments {
  readonly repository: string;
  readonly tag: string;
  readonly out?: string;
}

const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseVerifyPublishedArguments(argv: readonly string[]): VerifyPublishedArguments {
  const usage =
    "Usage: bun run scripts/release/verify-published-release.ts --tag v<major>.<minor>.<patch> " +
    "[--repo <owner>/<name>] [--out <evidence.json>]";
  const flagValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    return value;
  };
  const tag = flagValue("--tag");
  if (!tag) throw new Error(usage);
  const repository = flagValue("--repo") ?? "susumutomita/TenkaCloud";
  if (!REPOSITORY_SLUG.test(repository)) {
    throw new Error(`Repository ${JSON.stringify(repository)} is not an <owner>/<name> slug`);
  }
  return { repository, tag, out: flagValue("--out") };
}

/** The two network shapes this verifier needs, injectable so tests never reach the network. */
export interface ReleaseFetcher {
  json(url: string): Promise<unknown>;
  bytes(url: string): Promise<Uint8Array>;
}

export function httpReleaseFetcher(token?: string): ReleaseFetcher {
  const headers: Record<string, string> = {
    "User-Agent": "tenkacloud-release-verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = async (url: string, accept: string): Promise<Response> => {
    const response = await fetch(url, { headers: { ...headers, Accept: accept } });
    if (!response.ok) {
      throw new Error(`GET ${url} returned HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  };
  return {
    async json(url) {
      return (await request(url, "application/vnd.github+json")).json();
    },
    async bytes(url) {
      return new Uint8Array(await (await request(url, "application/octet-stream")).arrayBuffer());
    },
  };
}

export interface CollectPublishedReleaseOptions {
  readonly repository: string;
  readonly tag: string;
  readonly fetcher: ReleaseFetcher;
  readonly launcherDefaults: LauncherDefaults;
  readonly verifiedAt: string;
}

/**
 * Downloads everything a third party can see of a published Release. The unversioned tarball
 * is fetched a second time through the `releases/latest/download/` path — the URL the README
 * and CLI install instructions point at — because "the newest release is this release" is
 * itself part of the claim.
 */
export async function collectPublishedRelease(
  options: CollectPublishedReleaseOptions,
): Promise<PublishedReleaseInput> {
  const { repository, tag, fetcher } = options;
  const api = `https://api.github.com/repos/${repository}`;
  const index = parseReleaseAssetIndex(await fetcher.json(`${api}/releases/tags/${tag}`));
  const tagCommit = parseTagCommit(await fetcher.json(`${api}/commits/${tag}`));
  const assets: readonly DownloadedAsset[] = await Promise.all(
    index.map(async (asset) => ({ name: asset.name, bytes: await fetcher.bytes(asset.url) })),
  );
  const latest = await fetcher.bytes(
    `https://github.com/${repository}/releases/latest/download/${UNVERSIONED_CLI_ASSET}`,
  );
  return {
    tag,
    tagCommit,
    assets,
    latestDownloadSha256: sha256(latest),
    launcherDefaults: options.launcherDefaults,
    verifiedAt: options.verifiedAt,
  };
}

async function main(): Promise<void> {
  const { repository, tag, out } = parseVerifyPublishedArguments(process.argv.slice(2));
  const input = await collectPublishedRelease({
    repository,
    tag,
    fetcher: httpReleaseFetcher(process.env.GITHUB_TOKEN),
    launcherDefaults: readLauncherDefaults(),
    verifiedAt: new Date().toISOString(),
  });
  const evidence = verifyPublishedRelease(input);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (out) {
    writeFileSync(out, serialized);
    console.error(`Wrote ${out}`);
  }
  process.stdout.write(serialized);
  for (const check of evidence.checks) console.error(`verified: ${check}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
