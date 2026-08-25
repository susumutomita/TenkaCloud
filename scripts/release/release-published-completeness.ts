import { STABLE_RELEASE_TAG } from "./identity";
import { publishedReleaseAssetNames, RELEASE_WORKFLOW_PATH } from "./published-release";

/**
 * Post-publish completeness guard (#3024 structural gap).
 *
 * `release-cli.yml` validates its release identity and asset set at creation time, but
 * only when a `v*` tag is pushed through that workflow. A GitHub Release is a distinct
 * object from the tag: anyone with `contents: write` can call `gh release create` (or use
 * the web UI) against a tag directly, publishing a Release the workflow never built and
 * never checked. That already happened — `v1.2.1` and `v1.3.1` are both live Releases with
 * an empty asset list, published by a human account, not `github-actions[bot]` — so the
 * in-workflow contract alone is not the whole shipping contract.
 *
 * This module is the outside-in half: given only what the `release: published` webhook
 * event itself reports (tag, draft/prerelease flags, attached asset names), it decides
 * whether the release is in the scope this repository's pipeline ever produces, and if so,
 * whether the closed asset set `release-cli.yml` assembles is actually present. It never
 * checks out the tagged tree or resolves a manifest identity — a hand-created Release's tag
 * may not even point at a tree that satisfies the manifest schema (v1.3.1 does not), and a
 * guard that could only run on a healthy tree would not have caught the bug it exists for.
 * The required-asset derivation itself is not duplicated here: `publishedReleaseAssetNames`
 * already reads it off `release-cli.yml`'s own "Create the release once, with every asset
 * attached" step, so both the in-workflow and post-publish checks agree by construction.
 *
 * A missing or absent asset list must fail, never pass for lack of anything to compare —
 * that vacuous-pass shape is exactly the `v1.2.1` / `v1.3.1` bug.
 */

export interface ReleasePublishedEvent {
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assetNames: readonly string[];
}

export interface ReleaseCompletenessResult {
  readonly tagName: string;
  /** Whether this release is one `release-cli.yml` could ever have produced. */
  readonly inScope: boolean;
  /** Why the release is out of scope, when it is; null once it is evaluated. */
  readonly scopeReason: string | null;
  readonly requiredAssets: readonly string[];
  readonly missingAssets: readonly string[];
  readonly unexpectedAssets: readonly string[];
  readonly passed: boolean;
  readonly summary: string;
}

function describeList(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.map((name) => JSON.stringify(name)).join(", ");
}

function outOfScope(tagName: string, reason: string): ReleaseCompletenessResult {
  return {
    tagName,
    inScope: false,
    scopeReason: reason,
    requiredAssets: [],
    missingAssets: [],
    unexpectedAssets: [],
    passed: true,
    summary: `Not evaluated: ${reason}.`,
  };
}

/**
 * Decides whether a published release carries the required asset set. Pure: no network,
 * no filesystem, no git — every input is a value the `release` webhook event already
 * reports, so this is exercisable from fixtures alone.
 */
export function checkReleasePublishedCompleteness(
  event: ReleasePublishedEvent,
): ReleaseCompletenessResult {
  const { tagName, draft, prerelease, assetNames } = event;

  // Scope matches the pipeline's own reach: release-cli.yml only ever builds a `v*` tag
  // (`push: tags: v*`), and only ever creates a stable, non-prerelease Release (it stamps
  // the package version straight from the tag and never sets `--prerelease`). A draft or
  // prerelease Release, or a tag outside `v*` entirely, is not something this contract
  // governs, so it is reported as skipped rather than failed.
  if (!tagName.startsWith("v")) {
    return outOfScope(tagName, `tag ${JSON.stringify(tagName)} is not a v*-tagged release`);
  }
  if (draft) {
    return outOfScope(tagName, "release is a draft");
  }
  if (prerelease) {
    return outOfScope(tagName, "release is marked prerelease");
  }

  // In scope, but not a shape release-cli.yml's own tag check would ever accept
  // (`^v[0-9]+\.[0-9]+\.[0-9]+$`) — this is not "nothing to check", it is a release the
  // sanctioned pipeline could never have produced, so it fails rather than being skipped.
  if (!STABLE_RELEASE_TAG.test(tagName)) {
    return {
      tagName,
      inScope: true,
      scopeReason: null,
      requiredAssets: [],
      missingAssets: [],
      unexpectedAssets: [...assetNames],
      passed: false,
      summary:
        `Tag ${JSON.stringify(tagName)} does not match the v<major>.<minor>.<patch> shape ` +
        `${RELEASE_WORKFLOW_PATH} requires, so that workflow can never have produced this release.`,
    };
  }

  const version = tagName.slice(1);
  const requiredAssets = publishedReleaseAssetNames(version);
  const present = new Set(assetNames);
  const required = new Set(requiredAssets);
  const missingAssets = requiredAssets.filter((name) => !present.has(name));
  const unexpectedAssets = [...present].filter((name) => !required.has(name));
  const passed = missingAssets.length === 0;

  const summary = passed
    ? `All ${requiredAssets.length} required assets are attached to ${tagName}: ` +
      `${describeList(requiredAssets)}.`
    : `Release ${tagName} is missing ${missingAssets.length} of ${requiredAssets.length} ` +
      `required assets: ${describeList(missingAssets)}.`;

  return {
    tagName,
    inScope: true,
    scopeReason: null,
    requiredAssets,
    missingAssets,
    unexpectedAssets,
    passed,
    summary,
  };
}

interface RawReleasePayload {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid release webhook payload at ${path}: ${message}`);
}

/**
 * Reads the `release` object out of a `release: published` webhook payload (the shape
 * GitHub writes to `GITHUB_EVENT_PATH`). Rejects anything that does not carry the exact
 * fields this guard needs — a malformed payload must fail loudly, not be treated as an
 * empty, in-scope release with zero assets.
 */
export function parseReleasePublishedEvent(value: unknown): ReleasePublishedEvent {
  if (typeof value !== "object" || value === null) {
    fail("$", "expected an object with a release event payload");
  }
  const release = (value as { release?: unknown }).release;
  if (typeof release !== "object" || release === null) {
    fail("$.release", "expected the webhook event's release object");
  }
  const record = release as RawReleasePayload;
  if (typeof record.tag_name !== "string" || record.tag_name.length === 0) {
    fail("$.release.tag_name", "expected a non-empty string");
  }
  if (typeof record.draft !== "boolean") {
    fail("$.release.draft", "expected a boolean");
  }
  if (typeof record.prerelease !== "boolean") {
    fail("$.release.prerelease", "expected a boolean");
  }
  if (!Array.isArray(record.assets)) {
    fail("$.release.assets", "expected an array");
  }
  const assetNames = record.assets.map((asset, index) => {
    const name = (asset as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.length === 0) {
      fail(`$.release.assets[${index}].name`, "expected a non-empty string");
    }
    return name;
  });
  return {
    tagName: record.tag_name,
    draft: record.draft,
    prerelease: record.prerelease,
    assetNames,
  };
}
