import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { bumpCatalog, challengeUrl, findCatalogBump } from "./catalog-bump.js";

function gh(...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixed gh executable and arguments, no shell
  return execFileSync("gh", args, { encoding: "utf8" });
}

const root = resolve(import.meta.dirname, "../..");
const result = await findCatalogBump(root, process.env.CATALOG_TAG ?? "", {
  release: async (tag) => {
    const endpoint = tag ? `tags/${encodeURIComponent(tag)}` : "latest";
    return JSON.parse(gh("api", `repos/susumutomita/TenkaCloudChallenge/releases/${endpoint}`));
  },
  exists: async (branch) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- read-only remote branch query, no shell
    const remote = execFileSync("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
      encoding: "utf8",
    });
    const prs = z
      .array(z.object({ number: z.number() }))
      .parse(JSON.parse(gh("pr", "list", "--state", "open", "--head", branch, "--json", "number")));
    return remote.trim() !== "" || prs.length > 0;
  },
});
if (result) {
  const lock = bumpCatalog(root, result.plan);
  const revision = lock.sources.find((entry) => "url" in entry && entry.url === challengeUrl);
  if (!revision) throw new Error("Resolved TenkaCloudChallenge revision is missing");
  writeFileSync(
    "catalog-bump-body.md",
    [
      `Select TenkaCloudChallenge ${result.plan.oldTag} → ${result.release.tag_name}.`,
      "",
      `Resolved commit: \`${revision.commit}\``,
      `Content digest: \`${revision.digest}\``,
      `Release: ${result.release.html_url}`,
      "",
      "The previous revision remains pinned in retained for saved events.",
      "",
      "Owner: review the release notes and catalog diff for renamed problem IDs, required core changes and saved-event compatibility (as in #3404). Check CI before merging. While the host candidate has no built image, this PR also syncs its catalog pin in `release/host-candidate.json`.",
      "",
    ].join("\n"),
  );
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `branch=${result.branch}\ntag=${result.release.tag_name}\n`);
} else {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      "No catalog bump: no newer stable release, a non-semver current ref, or an existing branch/PR.\n",
    );
}
