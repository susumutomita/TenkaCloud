#!/usr/bin/env bun
/**
 * Verify that the current working tree (HEAD) merges cleanly into the latest
 * `origin/main`. Fails (exit 1) if any conflict would occur.
 *
 * Why: `make before-commit` historically didn't surface "your branch is stale
 * vs origin/main" issues — they only appeared at PR push time as DIRTY merge
 * state. Memory feedback_pull_main_before_task records the user's request to
 * pull latest main before starting work; this script enforces it programmatically.
 *
 * Mechanism:
 *   1. `git fetch origin main` to sync the remote ref.
 *   2. `git merge-tree --write-tree --no-messages origin/main HEAD` produces a
 *      synthetic tree object; any conflict makes the command exit non-zero (in
 *      newer git) or emit conflict markers in stdout. We treat either signal
 *      as failure.
 *   3. On main itself, skip (= no point checking).
 *   4. On detached HEAD / shallow clone / offline (= fetch fails), warn but
 *      pass (= don't block legitimate flows).
 */
import { execSync } from "node:child_process";

interface RunResult {
  readonly stdout: string;
  readonly status: number;
}

function run(cmd: string): RunResult {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    return { stdout, status: e.status ?? 1 };
  }
}

function currentBranch(): string {
  return run("git rev-parse --abbrev-ref HEAD").stdout.trim();
}

function fetchOriginMain(): boolean {
  const r = run("git fetch --quiet origin main");
  return r.status === 0;
}

function mergeTreeAgainstOriginMain(): { ok: boolean; details: string } {
  // `git merge-tree --write-tree` is the modern (git 2.38+) interface that does
  // a true three-way merge without touching the working tree. On conflict it
  // exits non-zero AND prints a structured conflict info block to stdout.
  const r = run("git merge-tree --write-tree --no-messages HEAD origin/main");
  if (r.status === 0) return { ok: true, details: "" };
  // Older git: fall back to plain `merge-tree` which prints markers to stdout.
  const base = run("git merge-base HEAD origin/main").stdout.trim();
  if (!base) {
    return { ok: false, details: "git merge-base HEAD origin/main failed (= no common ancestor)" };
  }
  const r2 = run(`git merge-tree ${base} HEAD origin/main`);
  const hasMarker = /^<<<<<<< |^=======$|^>>>>>>> /m.test(r2.stdout);
  if (!hasMarker) return { ok: true, details: "" };
  // Extract conflicting paths from `+<<<<<<< file` etc.
  const paths = Array.from(r2.stdout.matchAll(/\n@@ \S* (\S+) /g))
    .map((m) => m[1])
    .filter((s, i, a): s is string => typeof s === "string" && a.indexOf(s) === i);
  return {
    ok: false,
    details:
      paths.length > 0 ? `paths likely involved: ${paths.join(", ")}` : "see git merge-tree output",
  };
}

function main(): number {
  const branch = currentBranch();
  if (branch === "main" || branch === "HEAD") {
    console.log(`SKIP check-no-conflicts (= branch is "${branch}")`);
    return 0;
  }
  if (!fetchOriginMain()) {
    console.warn("WARN check-no-conflicts: failed to fetch origin/main (offline?); skipping");
    return 0;
  }
  const result = mergeTreeAgainstOriginMain();
  if (!result.ok) {
    console.error("ERROR check-no-conflicts: HEAD does NOT merge cleanly into origin/main.");
    if (result.details) console.error(`  ${result.details}`);
    console.error(
      "  → Run: git fetch origin main && git merge origin/main (resolve conflicts, then commit).",
    );
    console.error(
      "  → Or rebase: git fetch origin main && git rebase origin/main (= linear history).",
    );
    return 1;
  }
  console.log("OK  HEAD merges cleanly into origin/main");
  return 0;
}

process.exit(main());
