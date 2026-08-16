import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseIdentity } from "./identity";
import { exactObject, stringAt, stringMatching } from "./manifest-fields";
import { resolveIdentityFromLocalTag } from "./verify-release-identity";

export const LAUNCHER_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../../release/launcher-defaults.json",
);
export const LAUNCHER_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  "../../infrastructure/templates/lite-pipeline.yaml",
);

/**
 * The launcher default pair last published: the values every hand-written literal in
 * lite-pipeline.yaml must equal. Authored in release/launcher-defaults.json — by
 * `--from-tag` from a published tag's resolved identity (#3024 PR 5), never by editing
 * the template — and stamped into the template by this generator.
 */
export interface LauncherDefaults {
  readonly manifestVersion: string;
  readonly platformCommit: string;
  readonly catalogCommit: string;
}

const FULL_COMMIT = /^[a-f0-9]{40}$/;
// The version lands inside YAML scalars and a double-quoted shell echo, so keep it to
// characters that are inert in both.
const SHELL_SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

export function parseLauncherDefaults(value: unknown): LauncherDefaults {
  const record = exactObject(
    value,
    "$",
    ["manifestVersion", "platformCommit", "catalogCommit"],
    ["$comment"],
  );
  return {
    manifestVersion: stringMatching(
      record.manifestVersion,
      "$.manifestVersion",
      SHELL_SAFE_VERSION,
      "expected a version made of letters, digits, dots, and hyphens only",
    ),
    platformCommit: stringMatching(
      record.platformCommit,
      "$.platformCommit",
      FULL_COMMIT,
      "expected a lowercase full 40-hex platform commit",
    ),
    catalogCommit: stringMatching(
      record.catalogCommit,
      "$.catalogCommit",
      FULL_COMMIT,
      "expected a lowercase full 40-hex catalog commit",
    ),
  };
}

export function readLauncherDefaults(path = LAUNCHER_DEFAULTS_PATH): LauncherDefaults {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read launcher defaults ${path}: ${message}`);
  }
  return parseLauncherDefaults(value);
}

interface StampSite {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: (defaults: LauncherDefaults) => string;
}

/**
 * Every launcher literal site, each anchored tightly enough that a template refactor
 * that moves or reshapes a site fails loudly here instead of leaving a stale literal.
 * `$1`-style backreferences keep the anchors; only the value groups are rewritten.
 */
const STAMP_SITES: readonly StampSite[] = [
  {
    name: "RepoRef parameter default",
    pattern: /(\n {2}RepoRef:\n {4}Type: String\n {4}Default: )[a-f0-9]{40}(\n)/,
    replacement: (d) => `$1${d.platformCommit}$2`,
  },
  {
    name: "ProblemsRepoRef parameter default",
    pattern: /(\n {2}ProblemsRepoRef:\n {4}Type: String\n {4}Default: )[a-f0-9]{40}(\n)/,
    replacement: (d) => `$1${d.catalogCommit}$2`,
  },
  {
    name: "UsesCandidateReleasePair platform condition",
    pattern: /(- !Equals \[!Ref RepoRef, )[a-f0-9]{40}(\])/,
    replacement: (d) => `$1${d.platformCommit}$2`,
  },
  {
    name: "UsesCandidateReleasePair catalog condition",
    pattern: /(- !Equals \[!Ref ProblemsRepoRef, )[a-f0-9]{40}(\])/,
    replacement: (d) => `$1${d.catalogCommit}$2`,
  },
  {
    name: "buildspec manifest version echo",
    pattern:
      /(echo "Release manifest version: )[0-9A-Za-z.-]+( \(baseline for the exact candidate ref pair\)")/,
    replacement: (d) => `$1${d.manifestVersion}$2`,
  },
  {
    name: "buildspec candidate pair classification",
    pattern:
      /(elif \[ "\$\{REPO_REF\}" = ")[a-f0-9]{40}(" \] && \[ "\$\{PROBLEMS_REPO_REF\}" = ")[a-f0-9]{40}(" \]; then)/,
    replacement: (d) => `$1${d.platformCommit}$2${d.catalogCommit}$3`,
  },
  {
    name: "ReleaseManifestVersion output",
    pattern:
      /(\n {2}ReleaseManifestVersion:\n {4}Description: >-\n(?: {6}.+\n)+ {4}Value: )[0-9A-Za-z.-]+(\n)/,
    replacement: (d) => `$1${d.manifestVersion}$2`,
  },
];

/**
 * Returns the template with every launcher literal stamped from `defaults`.
 * Pure and idempotent; throws if any site is missing or ambiguous.
 */
export function stampLauncherDefaults(template: string, defaults: LauncherDefaults): string {
  let next = template;
  for (const site of STAMP_SITES) {
    const matches = next.match(new RegExp(site.pattern, "g"));
    if (matches?.length !== 1) {
      throw new Error(
        `Launcher literal site "${site.name}" matched ${matches?.length ?? 0} times; ` +
          "expected exactly 1. The template was refactored without updating " +
          "scripts/release/generate-launcher-defaults.ts.",
      );
    }
    next = next.replace(site.pattern, site.replacement(defaults));
  }
  return next;
}

/**
 * The launcher pair a published tag advertises. Derived from the tag's resolved identity
 * (#3024 PR 5) rather than transcribed: the platform commit only exists once the tag does,
 * and a mistyped SHA here would send every launcher build at a ref nobody released.
 */
export function launcherDefaultsFromIdentity(identity: ReleaseIdentity): LauncherDefaults {
  return {
    manifestVersion: identity.version,
    platformCommit: identity.platformCommit,
    catalogCommit: identity.catalogCommit,
  };
}

export function renderLauncherDefaults(defaults: LauncherDefaults, comment: string): string {
  return `${JSON.stringify({ $comment: comment, ...defaults }, null, 2)}\n`;
}

function advanceToTag(tag: string): void {
  const { identity } = resolveIdentityFromLocalTag(tag);
  const current = JSON.parse(readFileSync(LAUNCHER_DEFAULTS_PATH, "utf8")) as {
    $comment?: unknown;
  };
  const comment = stringAt(current.$comment, "$.$comment");
  writeFileSync(
    LAUNCHER_DEFAULTS_PATH,
    renderLauncherDefaults(launcherDefaultsFromIdentity(identity), comment),
  );
  console.log(`Advanced ${LAUNCHER_DEFAULTS_PATH} to the published identity of ${tag}`);
}

function main(): void {
  const check = process.argv.includes("--check");
  const fromTagIndex = process.argv.indexOf("--from-tag");
  if (fromTagIndex !== -1) {
    const tag = process.argv[fromTagIndex + 1];
    if (check || !tag || tag.startsWith("--")) {
      throw new Error(
        "Usage: bun run scripts/release/generate-launcher-defaults.ts " +
          "[--check | --from-tag v<major>.<minor>.<patch>]",
      );
    }
    advanceToTag(tag);
  }
  const defaults = readLauncherDefaults();
  const current = readFileSync(LAUNCHER_TEMPLATE_PATH, "utf8");
  const next = stampLauncherDefaults(current, defaults);
  if (check) {
    if (current !== next) {
      console.error(
        "Launcher template literals drift from release/launcher-defaults.json. Run " +
          "'bun run release:launcher-defaults' and commit the result.",
      );
      process.exit(1);
    }
    console.log("Launcher template literals match release/launcher-defaults.json.");
    return;
  }
  writeFileSync(LAUNCHER_TEMPLATE_PATH, next);
  console.log(`Stamped ${LAUNCHER_TEMPLATE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
