import { describe, expect, it } from "vitest";
import {
  checkSubmoduleNotBehind,
  type GitIO,
} from "../../../scripts/quality/check-submodule-not-behind";

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
      fetchSubmodule: (...pins) => fetchedPins.push(pins),
      isAncestor: () => true,
      containsChanges: () => false,
      log: () => undefined,
    };

    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(fetchedPins).toEqual([["main-pin", "pr-pin", "merge-base-pin"]]);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPinChange,
  containsPinnedChanges,
} from "../../../scripts/quality/check-submodule-not-behind";

it("accepts squashed content but rejects rollback, missing changes, conflicts, and invalid revisions", () => {
  const repository = mkdtempSync(join(tmpdir(), "submodule-pin-"));
  const git = (...args: string[]) =>
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- real git is the regression fixture
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
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
