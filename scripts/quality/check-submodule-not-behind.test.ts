import { describe, expect, it } from "bun:test";
import { checkSubmoduleNotBehind, type GitIO } from "./check-submodule-not-behind";

describe("checkSubmoduleNotBehind", () => {
  it("should give the fetcher every pin needed to restore shallow submodule ancestry", () => {
    const fetchedPins: string[][] = [];
    const io: GitIO = {
      readGitlink: (ref) =>
        new Map([
          ["origin/main", "main-pin"],
          ["HEAD", "pr-pin"],
          ["merge-base", "merge-base-pin"],
        ]).get(ref),
      mergeBase: () => "merge-base",
      fetchSubmodule: (...pins) => fetchedPins.push([...pins]),
      isAncestor: () => true,
      containsChanges: () => false,
      log: () => undefined,
    };

    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(fetchedPins).toEqual([["main-pin", "pr-pin", "merge-base-pin"]]);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPinChange,
  containsPinnedChanges,
  isolatedGitEnv,
} from "./check-submodule-not-behind";

function fixtureGit(repository: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- real git is the regression fixture
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: isolatedGitEnv(),
  }).trim();
}

it("isolates repository-local Git settings while preserving transport settings", () => {
  expect(
    isolatedGitEnv({
      PATH: "/usr/bin",
      GIT_DIR: "/caller/.git",
      GIT_INDEX_FILE: "/caller/.git/index",
      GIT_CONFIG: "/caller/.git/config",
      GIT_CONFIG_PARAMETERS: "core.bare=true",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_GLOBAL: "/global/gitconfig",
      GIT_CONFIG_SYSTEM: "/system/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_SSH_COMMAND: "ssh -i /identity",
      GIT_ASKPASS: "/askpass",
    }),
  ).toEqual({
    PATH: "/usr/bin",
    GIT_CONFIG_GLOBAL: "/global/gitconfig",
    GIT_CONFIG_SYSTEM: "/system/gitconfig",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: "ssh -i /identity",
    GIT_ASKPASS: "/askpass",
  });
});

it("accepts squashed content but rejects rollback, missing changes, conflicts, and invalid revisions", () => {
  const repository = mkdtempSync(join(tmpdir(), "submodule-pin-"));
  const git = (...args: string[]) => fixtureGit(repository, ...args);
  const commit = (file: string, value: string) => {
    writeFileSync(join(repository, file), value);
    git("add", file);
    git("commit", "-m", value);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Pin test");
    git("config", "user.email", "pin@example.test");
    const base = commit("base.txt", "base");
    git("checkout", "-b", "feature");
    const existing = commit("feature.txt", "existing fix");
    git("checkout", "main");
    const missing = commit("main.txt", "new main change");
    git("merge", "--squash", "feature");
    git("commit", "-m", "squashed fix");
    const proposed = git("rev-parse", "HEAD");
    expect(() => git("merge-base", "--is-ancestor", existing, proposed)).toThrow();
    expect(containsPinnedChanges(repository, existing, proposed)).toBe(true);
    expect(
      classifyPinChange(
        existing,
        proposed,
        base,
        () => false,
        (a, b) => containsPinnedChanges(repository, a, b),
      ),
    ).toBe("integrated");
    expect(containsPinnedChanges(repository, existing, missing)).toBe(false);
    expect(containsPinnedChanges(repository, proposed, base)).toBe(false);
    git("checkout", "-b", "conflicting", missing);
    const conflicting = commit("feature.txt", "different fix");
    expect(containsPinnedChanges(repository, existing, conflicting)).toBe(false);
    expect(containsPinnedChanges(repository, existing, "missing-revision")).toBe(false);
    expect(
      classifyPinChange(
        existing,
        missing,
        base,
        () => false,
        () => false,
      ),
    ).toBe("behind-or-diverged");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

it("uses the target repository under a caller hook environment without changing the caller", () => {
  const caller = mkdtempSync(join(tmpdir(), "submodule-pin-caller-"));
  const target = mkdtempSync(join(tmpdir(), "submodule-pin-target-"));
  const git = fixtureGit;
  const initialize = (repository: string) => {
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Pin test");
    git(repository, "config", "user.email", "pin@example.test");
  };
  const commit = (repository: string, filename: string, value: string) => {
    writeFileSync(join(repository, filename), value);
    git(repository, "add", filename);
    git(repository, "commit", "-m", value);
    return git(repository, "rev-parse", "HEAD");
  };
  try {
    initialize(caller);
    initialize(target);
    const callerHead = commit(caller, "caller.txt", "caller");
    const callerConfig = readFileSync(join(caller, ".git/config"));
    const callerIndex = readFileSync(join(caller, ".git/index"));
    const base = commit(target, "base.txt", "base");
    const proposed = commit(target, "feature.txt", "feature");
    const moduleUrl = new URL("./check-submodule-not-behind.ts", import.meta.url).href;
    const code = `import { containsPinnedChanges } from ${JSON.stringify(moduleUrl)}; console.log(containsPinnedChanges(${JSON.stringify(target)}, ${JSON.stringify(base)}, ${JSON.stringify(proposed)}));`;
    const hookEnvironment = {
      ...process.env,
      GIT_DIR: join(caller, ".git"),
      GIT_COMMON_DIR: join(caller, ".git"),
      GIT_WORK_TREE: caller,
      GIT_INDEX_FILE: join(caller, ".git/index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    };
    const output = execFileSync(process.execPath, ["-e", code], {
      cwd: caller,
      env: hookEnvironment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output.trim()).toBe("true");
    expect(git(caller, "rev-parse", "HEAD")).toBe(callerHead);
    expect(readFileSync(join(caller, ".git/config"))).toEqual(callerConfig);
    expect(readFileSync(join(caller, ".git/index"))).toEqual(callerIndex);
  } finally {
    rmSync(caller, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

it("uses content integration only for a changed divergent pin", () => {
  const calls: string[][] = [];
  const io: GitIO = {
    readGitlink: (ref) =>
      new Map([
        ["origin/main", "existing"],
        ["HEAD", "proposed"],
        ["fork", "base"],
      ]).get(ref),
    mergeBase: () => "fork",
    fetchSubmodule: () => undefined,
    isAncestor: () => false,
    containsChanges: (...pins) => {
      calls.push(pins);
      return true;
    },
    log: () => undefined,
  };
  expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
  expect(calls).toEqual([["existing", "proposed"]]);
  expect(
    classifyPinChange(
      "existing",
      "proposed",
      "proposed",
      () => false,
      () => {
        throw new Error("untouched pins need no fallback");
      },
    ),
  ).toBe("untouched");
});

it("rejects an older commit even when a revert made its tree identical", () => {
  expect(
    classifyPinChange(
      "current",
      "older",
      "base",
      (ancestor, descendant) => ancestor === "older" && descendant === "current",
      () => {
        throw new Error("a rollback must not use content equivalence");
      },
    ),
  ).toBe("behind-or-diverged");
});
