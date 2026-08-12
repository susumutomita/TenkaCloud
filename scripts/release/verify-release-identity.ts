import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveReleaseIdentity } from "./identity";
import { parseReleaseManifest } from "./manifest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// Fixed binary path so which `git` runs is never delegated to a writable PATH entry
// (sonarjs/no-os-command-from-path); matches the release test suite's GIT_BINARY.
const GIT_BINARY = "/usr/bin/git";

export interface VerifyIdentityArguments {
  readonly tag: string;
}

export function parseVerifyIdentityArguments(argv: readonly string[]): VerifyIdentityArguments {
  const tagIndex = argv.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : argv[tagIndex + 1];
  if (!tag || tag.startsWith("--")) {
    throw new Error(
      "Usage: bun run scripts/release/verify-release-identity.ts --tag v<major>.<minor>.<patch>",
    );
  }
  return { tag };
}

function gitOutput(args: readonly string[]): string {
  return execFileSync(GIT_BINARY, [...args], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * Resolves and validates the release identity of an existing local `v*` tag, printing
 * the resolved identity JSON on success. The release workflow (#3024 PR 3) runs this
 * before building any artifact so a tag/manifest/catalog disagreement never reaches
 * `gh release create`; the printed identity feeds the attestation.
 *
 * Everything is read from the TAGGED tree, not the working tree: the identity being
 * published is the tag's, and workflow_dispatch backfills may run from any checkout.
 */
function main(): void {
  const { tag } = parseVerifyIdentityArguments(process.argv.slice(2));
  const tagCommit = gitOutput(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const catalogGitlink = gitOutput(["ls-tree", tagCommit, "problems"]).split(/\s+/)[2];
  if (!catalogGitlink) {
    throw new Error(`The tagged tree ${tag} has no problems gitlink to compare`);
  }
  const manifestJson = gitOutput(["show", `${tagCommit}:release/tenkacloud-release.json`]);
  const manifest = parseReleaseManifest(JSON.parse(manifestJson));
  const identity = resolveReleaseIdentity(manifest, { tag, tagCommit, catalogGitlink });
  console.log(JSON.stringify(identity, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
