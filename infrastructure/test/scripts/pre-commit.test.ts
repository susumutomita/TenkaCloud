import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../../../.husky/pre-commit", import.meta.url));
let directory: string;
let repository: string;
let catalog: string;
let gateLog: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- real Git exercises hook checkout/index behavior
  return execFileSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, content: string): void {
  writeFileSync(join(cwd, "example.txt"), content);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", content);
}

function runHook() {
  return spawnSync("/bin/sh", [hook], { cwd: repository, env, encoding: "utf8" });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tenkacloud-hook-"));
  repository = join(directory, "platform");
  catalog = join(repository, "problems");
  gateLog = join(directory, "gate.log");
  const source = join(directory, "catalog source");
  const bin = join(directory, "bin");
  // Hooks export GIT_* variables. Fixtures must never inherit the caller's index or repository.
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Hook test",
    GIT_AUTHOR_EMAIL: "hook@example.test",
    GIT_COMMITTER_NAME: "Hook test",
    GIT_COMMITTER_EMAIL: "hook@example.test",
    PATH: `${bin}:${process.env.PATH}`,
    PRE_COMMIT_GATE_LOG: gateLog,
    PRE_COMMIT_GATE_EXIT: "0",
  });
  for (const path of [repository, source, bin]) mkdirSync(path);
  writeFileSync(
    join(bin, "mise"),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$PRE_COMMIT_GATE_LOG"\nexit "$PRE_COMMIT_GATE_EXIT"\n',
    { mode: 0o755 },
  );
  for (const path of [source, repository]) git(path, "init", "--initial-branch=main");
  commit(source, "original catalog");
  git(repository, "-c", "protocol.file.allow=always", "submodule", "add", source, "problems");
  commit(repository, "platform");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("pre-commit catalog check", () => {
  it("preserves a matching branch, dirty files, and the index while running the quality gate", () => {
    git(catalog, "switch", "-c", "work-in-progress");
    writeFileSync(join(catalog, "example.txt"), "unfinished edit");
    writeFileSync(join(catalog, "notes.txt"), "untracked work");
    const before = git(repository, "status", "--porcelain=v1");
    const index = git(repository, "ls-files", "--stage");
    expect(runHook().status).toBe(0);
    expect(readFileSync(gateLog, "utf8")).toBe("exec -- make before-commit\n");
    expect(git(repository, "status", "--porcelain=v1")).toBe(before);
    expect(git(repository, "ls-files", "--stage")).toBe(index);
    expect(git(catalog, "branch", "--show-current")).toBe("work-in-progress");
    expect(readFileSync(join(catalog, "example.txt"), "utf8")).toBe("unfinished edit");
    expect(readFileSync(join(catalog, "notes.txt"), "utf8")).toBe("untracked work");
  });

  it("rejects an unstaged catalog update without moving HEAD or running the quality gate", () => {
    commit(catalog, "new catalog");
    const head = git(catalog, "rev-parse", "HEAD");
    const index = git(repository, "ls-files", "--stage");
    const result = runHook();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("differs from its staged commit");
    expect(git(catalog, "rev-parse", "HEAD")).toBe(head);
    expect(git(repository, "ls-files", "--stage")).toBe(index);
    expect(existsSync(gateLog)).toBe(false);
  });

  it("accepts an intentionally staged catalog update", () => {
    commit(catalog, "new catalog");
    git(repository, "add", "problems");
    const index = git(repository, "ls-files", "--stage");
    expect(runHook().status).toBe(0);
    expect(existsSync(gateLog)).toBe(true);
    expect(git(repository, "ls-files", "--stage")).toBe(index);
  });

  it("rejects an uninitialized catalog without initializing it", () => {
    git(repository, "submodule", "deinit", "--force", "problems");
    expect(runHook().status).toBe(1);
    expect(existsSync(join(catalog, ".git"))).toBe(false);
    expect(existsSync(gateLog)).toBe(false);
  });

  it("does not hide Git failures or continue to the quality gate", () => {
    env.GIT_DIR = join(directory, "missing.git");
    const result = runHook();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a git repository");
    expect(existsSync(gateLog)).toBe(false);
  });

  it("propagates a failed quality gate", () => {
    env.PRE_COMMIT_GATE_EXIT = "19";
    expect(runHook().status).toBe(19);
    expect(existsSync(gateLog)).toBe(true);
  });
});
