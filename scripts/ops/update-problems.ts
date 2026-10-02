#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPinChange, isolatedGitEnv } from "../quality/check-submodule-not-behind";

function trackedSource(
  root: string,
  catalog: string,
  commands: {
    git: (cwd: string, ...args: string[]) => string;
    option: (cwd: string, ...args: string[]) => string | undefined;
  },
): { remote: string; branch: string } {
  const { git, option } = commands;
  const catalogBranch = option(catalog, "symbolic-ref", "--quiet", "--short", "HEAD");
  const remote =
    (catalogBranch && option(catalog, "config", "--get", `branch.${catalogBranch}.remote`)) ||
    "origin";
  let branch =
    option(root, "config", "--get", "submodule.problems.branch") ??
    option(root, "config", "-f", ".gitmodules", "--get", "submodule.problems.branch") ??
    "HEAD";
  if (branch === ".") {
    const parentBranch = option(root, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (!parentBranch)
      throw new Error("The catalog tracks the parent branch, but the parent HEAD is detached.");
    branch = parentBranch;
  }
  if (branch !== "HEAD") git(catalog, "check-ref-format", `refs/heads/${branch}`);
  return { remote, branch };
}

/** Fetch first, then select only an equal or descendant commit; never discard local work. */
export function updateProblems(root: string): void {
  const catalog = join(root, "problems");
  const env = { ...isolatedGitEnv(), GIT_OPTIONAL_LOCKS: "0" };
  const run = (cwd: string, args: string[], allowAbsent = false): string | undefined => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- use the operator's Git installation and transport configuration
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (allowAbsent && result.status === 1) return undefined;
    if (result.status !== 0)
      throw new Error(result.error?.message ?? (result.stderr.trim() || "Git command failed."));
    return result.stdout.trim();
  };
  const git = (cwd: string, ...args: string[]): string => run(cwd, args) ?? "";
  const option = (cwd: string, ...args: string[]) => run(cwd, args, true);
  const stagedPin = () => {
    const entry = git(root, "ls-files", "--stage", "--", "problems");
    const match = /^160000 ([a-f0-9]{40,64}) 0\tproblems$/u.exec(entry);
    if (!match?.[1]) throw new Error("problems must have one resolved submodule pin in the index.");
    return match[1];
  };
  const currentPin = () => git(catalog, "rev-parse", "--verify", "HEAD^{commit}");
  const assertClean = () => {
    if (git(catalog, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"))
      throw new Error(
        "Problem sources have local changes. Preserve and review them before updating; no checkout or staging was performed.",
      );
  };

  // An empty submodule directory must not let Git discover the parent repository instead.
  if (git(catalog, "rev-parse", "--show-toplevel") !== realpathSync(catalog))
    throw new Error(
      "Initialize the pinned catalog with git submodule update --init --recursive problems first.",
    );
  assertClean();
  const current = currentPin();
  if (stagedPin() !== current)
    throw new Error(
      "The problem checkout differs from its staged pin. Review that selection first; no checkout or staging was performed.",
    );

  const { remote, branch } = trackedSource(root, catalog, { git, option });
  const shallow = git(catalog, "rev-parse", "--is-shallow-repository") === "true";
  git(
    catalog,
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    ...(shallow ? ["--unshallow"] : []),
    "--",
    remote,
    branch === "HEAD" ? "HEAD" : `refs/heads/${branch}`,
  );
  const target = git(catalog, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
  const verdict = classifyPinChange(
    current,
    target,
    undefined,
    (ancestor, descendant) =>
      option(catalog, "merge-base", "--is-ancestor", ancestor, descendant) !== undefined,
  );
  if (verdict !== "ahead" && verdict !== "unchanged")
    throw new Error(
      `Refusing catalog rollback or divergence: ${remote}/${branch} (${target}) does not descend from the current pin (${current}). Keep the reviewed pin until its commits reach the tracked branch. No checkout or staging was performed.`,
    );

  // Recheck after transport, before either checkout or staging can change user work.
  assertClean();
  if (currentPin() !== current || stagedPin() !== current)
    throw new Error("The problem pin changed during fetch. No checkout or staging was performed.");
  if (target === current) {
    console.log("problems already at the latest pin.");
    return;
  }
  git(catalog, "checkout", "--no-overwrite-ignore", "--detach", target);
  git(catalog, "submodule", "update", "--init", "--recursive", "--checkout");
  git(root, "add", "--", "problems");
  console.log("problems bumped + staged — review the submodule diff, then commit.");
}

if (import.meta.main) {
  try {
    updateProblems(fileURLToPath(new URL("../../", import.meta.url)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
