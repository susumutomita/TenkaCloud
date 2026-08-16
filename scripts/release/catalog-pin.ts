import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FULL_COMMIT, parseReleaseManifest, RELEASE_MANIFEST_PATH } from "./manifest";

/**
 * Keeps the release BOM's catalog pin equal to the `problems` gitlink the platform
 * actually ships (#3024 PR 5).
 *
 * `scripts/release/identity.ts` refuses to publish a tag whose tagged tree records a
 * different gitlink than the manifest's catalog commit — correct, but that verdict lands
 * after the tag is pushed, when the only repair is deleting the tag. The two values drift
 * apart silently in the meantime: every submodule bump advances the gitlink and nothing
 * touches the manifest. This module makes the same invariant continuous, so `main` is
 * never in a state that cannot be tagged, and stamps the pin from the gitlink rather than
 * asking anyone to retype a 40-hex SHA.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// Fixed binary path so which `git` runs is never delegated to a writable PATH entry
// (sonarjs/no-os-command-from-path); matches verify-release-identity.ts.
const GIT_BINARY = "/usr/bin/git";

/**
 * The `sources.catalog.commit` site. Anchored on the surrounding keys so a manifest
 * reshape fails loudly here instead of leaving the pin unstamped, and narrow enough that
 * only the SHA is rewritten — the file keeps its committed formatting, which a
 * JSON.stringify round-trip would not.
 */
const CATALOG_COMMIT_SITE =
  /("catalog": \{\n {6}"repository": "[^"\n]+",\n {6}"commit": ")[a-f0-9]{40}(")/;

/** Reads the gitlink that a commit made here would record, i.e. the index — not the
 * submodule worktree, which may sit on any commit while the pin says otherwise. */
export function readCatalogGitlink(repoRoot = REPO_ROOT): string {
  const entry = execFileSync(GIT_BINARY, ["ls-files", "-s", "--", "problems"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const gitlink = /^160000 ([a-f0-9]{40}) /.exec(entry)?.[1];
  if (!gitlink) {
    throw new Error(
      `Could not read the problems gitlink from the git index (got ${JSON.stringify(entry)}). ` +
        "The catalog pin can only be checked inside a git checkout of this repository.",
    );
  }
  return gitlink;
}

/**
 * Returns the manifest text with `sources.catalog.commit` set to `gitlink`. Pure and
 * idempotent; throws when the site is missing, ambiguous, or when the result is not a
 * valid manifest — advancing the catalog under evidence bound to the old pin, for
 * instance, must fail rather than quietly invalidate the release contract.
 */
export function stampCatalogPin(manifestJson: string, gitlink: string): string {
  if (!FULL_COMMIT.test(gitlink)) {
    throw new Error(
      `Catalog gitlink ${JSON.stringify(gitlink)} is not a lowercase full 40-hex commit.`,
    );
  }
  const matches = manifestJson.match(new RegExp(CATALOG_COMMIT_SITE, "g"));
  if (matches?.length !== 1) {
    throw new Error(
      `The manifest catalog commit site matched ${matches?.length ?? 0} times; expected exactly 1. ` +
        "release/tenkacloud-release.json was reshaped without updating " +
        "scripts/release/catalog-pin.ts.",
    );
  }
  const next = manifestJson.replace(CATALOG_COMMIT_SITE, `$1${gitlink}$2`);
  parseReleaseManifest(JSON.parse(next));
  return next;
}

function main(): void {
  const check = process.argv.includes("--check");
  const gitlink = readCatalogGitlink();
  const current = readFileSync(RELEASE_MANIFEST_PATH, "utf8");
  const next = stampCatalogPin(current, gitlink);
  if (check) {
    if (current !== next) {
      console.error(
        `The release manifest catalog commit differs from the problems gitlink ${gitlink}. ` +
          "A tag pushed from this tree would fail release identity validation. Run " +
          "'bun run release:catalog-pin' and commit the result.",
      );
      process.exit(1);
    }
    console.log(`Release manifest catalog commit matches the problems gitlink ${gitlink}.`);
    return;
  }
  writeFileSync(RELEASE_MANIFEST_PATH, next);
  console.log(`Stamped ${RELEASE_MANIFEST_PATH} catalog commit to ${gitlink}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
