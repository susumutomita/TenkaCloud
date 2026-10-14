import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedGitPackRoot } from "../git-fetcher.js";

test("real Git transport refuses linked pack roots and linked parent paths before copying external bytes", () => {
  const work = mkdtempSync(join(tmpdir(), "git-root-check-"));
  const external = mkdtempSync(join(tmpdir(), "git-root-external-"));
  try {
    writeFileSync(join(external, "private.txt"), "not catalog material");
    symlinkSync(external, join(work, "pack"), "dir");
    expect(() => checkedGitPackRoot(work, "pack")).toThrow("symbolic link");
    mkdirSync(join(work, "safe", "nested"), { recursive: true });
    symlinkSync(join(work, "safe"), join(work, "parent"), "dir");
    expect(() => checkedGitPackRoot(work, "parent/nested")).toThrow("symbolic link");
    expect(() => checkedGitPackRoot(work, "../escape")).toThrow("Invalid");
    expect(checkedGitPackRoot(work, "safe/nested")).toBe(join(work, "safe/nested"));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
