/**
 * [Problem Packs product entry points / Issue #2460] Drift guard for the
 * README-facing `make pack-*` quickstart introduced alongside the Problem Pack
 * CLI wrappers.
 *
 * Two independent seams can silently drift out of sync with each other:
 *   1. README quickstart → root Makefile: a `make pack-<name>` command shown in
 *      the README's Problem Pack quickstart block must exist as an actual
 *      `pack-<name>` target in the root Makefile (renaming/removing a Makefile
 *      target must not leave a dead command in the docs).
 *   2. Root Makefile → pack CLI: every `pack-<name>` Makefile target must
 *      delegate to a subcommand the offline `pack` CLI
 *      (`infrastructure/lib/problem-pack/pack-cli.ts`) actually dispatches
 *      (renaming/removing a CLI subcommand must not leave a dead Makefile
 *      target).
 *
 * Both checks are pure text parsing of the checked-in files — no `make` or
 * pack-CLI subprocess spawn — so the guard is fast and has no side effects.
 * All helper code lives in this file (not `lib/`) per the coverage convention
 * for infrastructure workspace test-only helpers.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readmePath = join(repoRoot, "README.md");
const makefilePath = join(repoRoot, "Makefile");
const packCliPath = join(repoRoot, "infrastructure", "lib", "problem-pack", "pack-cli.ts");

/**
 * Extract the fenced ```bash code block that carries the Problem Pack
 * quickstart — identified by containing the sequence's first command,
 * `pack-init` — from the README. Throws if no such block exists, so a
 * README rewrite that drops the quickstart entirely fails loudly instead of
 * silently passing with zero assertions.
 */
function extractPackQuickstartBlock(readme: string): string {
  const fenceRegex = /```bash\n([\s\S]*?)```/g;
  for (const match of readme.matchAll(fenceRegex)) {
    if (match[1].includes("pack-init")) return match[1];
  }
  throw new Error(
    "README.md has no ```bash code block containing 'pack-init' — the Problem Pack quickstart block is missing or was rewritten.",
  );
}

/** Extract every distinct `make pack-<name>` invocation from a text block. */
function extractMakePackCommands(block: string): string[] {
  const targets = new Set<string>();
  for (const match of block.matchAll(/\bmake (pack-[a-zA-Z0-9_-]+)\b/g)) {
    targets.add(match[1]);
  }
  return [...targets];
}

/**
 * Parse the root Makefile's `pack-*` targets into `target name -> delegated
 * pack-CLI subcommand`. Accept both an inline recipe and the conventional
 * tab-indented recipe on the following line.
 */
function extractMakefilePackTargets(makefile: string): Map<string, string> {
  const targets = new Map<string, string>();
  const targetPattern = /^(pack-[a-zA-Z0-9_-]+):([^\n]*)(?:\n((?:\t[^\n]*(?:\n|$))*))?/gm;
  for (const match of makefile.matchAll(targetPattern)) {
    const recipe = `${match[2]}\n${match[3] ?? ""}`;
    const delegation = recipe.match(/\$\(PACK\)\s+(\S+)/);
    if (delegation) targets.set(match[1], delegation[1]);
  }
  return targets;
}

/**
 * Parse `pack-cli.ts`'s dispatcher for the subcommand strings it `case`s on.
 * Cheaper and more robust than importing the module: it doesn't require a
 * running dispatch, just the literal switch-case surface, which is exactly
 * what a Makefile target's `$(PACK) <subcommand>` needs to match.
 */
function extractPackCliSubcommands(source: string): Set<string> {
  const subcommands = new Set<string>();
  for (const match of source.matchAll(/case "([a-z]+)":/g)) {
    subcommands.add(match[1]);
  }
  return subcommands;
}

describe("Problem Pack DX drift guard (#2460)", () => {
  const readme = readFileSync(readmePath, "utf-8");
  const makefile = readFileSync(makefilePath, "utf-8");
  const packCliSource = readFileSync(packCliPath, "utf-8");

  it("should point every README quickstart make-pack command at a real Makefile target", () => {
    const quickstartBlock = extractPackQuickstartBlock(readme);
    const readmeCommands = extractMakePackCommands(quickstartBlock);
    expect(readmeCommands.length).toBeGreaterThan(0);

    const makefileTargets = extractMakefilePackTargets(makefile);
    for (const command of readmeCommands) {
      expect(
        makefileTargets.has(command),
        `README references 'make ${command}' but the Makefile has no such target`,
      ).toBe(true);
    }
  });

  it("should delegate every Makefile pack-* target to a subcommand the pack CLI dispatches", () => {
    const makefileTargets = extractMakefilePackTargets(makefile);
    expect(makefileTargets.size).toBeGreaterThan(0);

    const cliSubcommands = extractPackCliSubcommands(packCliSource);
    for (const [target, subcommand] of makefileTargets) {
      expect(
        cliSubcommands.has(subcommand),
        `Makefile target '${target}' delegates to pack subcommand '${subcommand}', which pack-cli.ts does not dispatch`,
      ).toBe(true);
    }
  });
});
