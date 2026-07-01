/**
 * [Problem Packs / Issue #2097] The REAL Git transport for `pack install git`.
 *
 * Split out of `git-source.ts` (SRP — Issue #986) so the validation + install
 * orchestration stays separate from the process-spawning transport. This module
 * owns the single place that shells out to `git`; it is injected into
 * `installGitPack` as the default {@link GitArchiveFetcher}, and unit tests
 * substitute an offline fetcher so this code never spawns a process in CI.
 *
 * It performs a SHALLOW, hooks-disabled fetch of EXACTLY the pinned commit, checks
 * it out into a scratch worktree, and copies the pack root (optionally a subdir)
 * into the destination. We only move files — no Git hook and no package-manager
 * lifecycle script is ever invoked.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitArchiveFetcher } from "./git-source.js";

/** Hard ceiling on any single `git` invocation so a stalled remote cannot hang. */
const GIT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * The real Git transport. The invocation is hardened so the HTTPS-only +
 * pinned-commit guarantee cannot be subverted by ambient configuration:
 *   - `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`
 *     neutralize system/global config so a `url.*.insteadOf` rewrite cannot turn
 *     the pinned `https://` URL into `ssh://` (or any other transport).
 *   - `-c credential.helper=` clears every credential helper and
 *     `GIT_TERMINAL_PROMPT=0` forbids interactive prompts, so a private repo fails
 *     fast instead of hanging or leaking credentials.
 *   - `-c protocol.allow=never` + `-c protocol.https.allow=always` permit ONLY
 *     HTTPS, as a defense-in-depth backstop to the URL validation.
 *   - `-c core.hooksPath=/dev/null` disables every Git hook.
 *   - a per-command `timeout` prevents a stalled remote from hanging the process.
 */
export const realGitArchiveFetcher: GitArchiveFetcher = (request) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-git-clone-"));
  try {
    const git = (args: readonly string[]): void => {
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          ...args,
        ],
        {
          cwd: work,
          stdio: ["ignore", "ignore", "pipe"],
          timeout: GIT_COMMAND_TIMEOUT_MS,
          env: {
            ...process.env,
            // Never prompt; fail fast on a private repo instead of hanging.
            GIT_TERMINAL_PROMPT: "0",
            // Neutralize ambient config (insteadOf rewrites, credential helpers).
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
          },
        },
      );
    };
    // Initialize an empty repo, fetch ONLY the pinned commit, and check it out.
    // This never resolves a branch / tag — the commit is the only ref fetched.
    git(["init", "--quiet"]);
    git(["remote", "add", "origin", request.repositoryUrl]);
    git(["fetch", "--depth", "1", "--no-tags", "origin", request.commit]);
    git(["checkout", "--quiet", "FETCH_HEAD"]);

    const packRoot =
      request.subdir.length > 0 ? path.join(work, ...request.subdir.split("/")) : work;
    copyPackRoot(packRoot, request.destinationDir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

/**
 * Copy a checked-out pack root into `destinationDir`, excluding `.git` and other
 * VCS/build noise. Only regular files and directories are copied; symlinks are
 * skipped (they are excluded from snapshots and the digest anyway).
 */
function copyPackRoot(packRoot: string, destinationDir: string): void {
  if (!fs.existsSync(packRoot) || !fs.statSync(packRoot).isDirectory()) {
    throw new Error(`Pack root '${packRoot}' was not found in the fetched repository.`);
  }
  for (const entry of fs.readdirSync(packRoot, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const from = path.join(packRoot, entry.name);
    const to = path.join(destinationDir, entry.name);
    fs.cpSync(from, to, { recursive: true });
  }
}
