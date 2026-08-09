import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Issue #2963: 別ディレクトリで一度 local play を起動していると `make local` が必ず落ちる。
 *
 * compose は project 名を指定しないとカレントディレクトリ名を使う。このリポジトリは worktree を
 * 常用するので、primary clone では `tenkacloud`、`.claude/worktrees/<name>` からは `<name>` に
 * なる。一方 container 名と volume 名は compose.local.yaml で固定されているため project だけが
 * 食い違い、
 *
 *   - volume "tenkacloud-local-data" already exists but was created for project "tenkacloud"
 *   - Conflict. The container name "/tenkacloud-local" is already in use
 *
 * を必ず踏む。image の build までは成功するので、落ちるのは container 作成の段階だけだった。
 *
 * ここで固定するのは 2 点。
 *
 *  1. project 名が **起動ディレクトリに依存しない**こと
 *  2. 別 project の固定名 container が居ても、`make local` が自力で回収して先に進むこと
 *     (= docker daemon の生の Conflict を出して終わらない)
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const LAUNCHER = join(REPO_ROOT, "scripts", "local", "docker-launcher.sh");
const launcherText = readFileSync(LAUNCHER, "utf8");

/** launcher から 1 つの関数定義だけを取り出す (末尾の dispatch を走らせないため)。 */
function functionSource(name: string): string {
  const start = launcherText.indexOf(`${name}() {`);
  expect(start, `${name}() が launcher に見つからない`).toBeGreaterThan(-1);
  const end = launcherText.indexOf("\n}\n", start);
  expect(end, `${name}() の終端が見つからない`).toBeGreaterThan(start);
  return launcherText.slice(start, end + 3);
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "docker-launcher-project-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * `reclaim_foreign_control_plane_container` を、偽の `docker` を PATH に置いて走らせる。
 * `docker inspect` が返す project 名と `docker rm` の成否をシナリオごとに差し替える。
 */
function reclaimWith(options: {
  readonly existingProject: string | null;
  readonly removeFails?: boolean;
}): { readonly status: number; readonly stderr: string; readonly removed: string } {
  const bin = join(sandbox, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const removeLog = join(sandbox, "removed.log");

  // inspect: container が無いケースは非 0 で終了する (実物と同じ)。
  const inspectBody =
    options.existingProject === null
      ? 'echo "No such object" >&2; exit 1'
      : `echo '${options.existingProject}'`;
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1" = "inspect" ]; then',
      `  ${inspectBody}`,
      "fi",
      'if [ "$1" = "rm" ]; then',
      `  echo "$3" >> "${removeLog}"`,
      `  exit ${options.removeFails ? "1" : "0"}`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -eu",
      'COMPOSE_PROJECT="tenkacloud-local"',
      'CONTROL_PLANE_CONTAINER="tenkacloud-local"',
      functionSource("reclaim_foreign_control_plane_container"),
      "reclaim_foreign_control_plane_container",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: sandbox,
  };
  // 成功時にも stderr を読む必要がある (= 回収したことを伝える案内文は成功経路に出る)。
  const result = spawnSync("/bin/sh", [script], { env, encoding: "utf8" });
  const status = result.status ?? 1;
  const stderr = result.stderr ?? "";
  let removed = "";
  try {
    removed = readFileSync(removeLog, "utf8");
  } catch {
    removed = "";
  }
  return { status, stderr, removed };
}

describe("compose project name is pinned (#2963)", () => {
  it("should pass an explicit -p so the project does not come from the directory name", () => {
    // ここが無いと worktree から起動した瞬間に project が変わり、volume 所有者の警告と
    // container 名衝突を必ず踏む。
    expect(launcherText).toMatch(/COMPOSE="docker compose -p \$\{COMPOSE_PROJECT\} -f/);
    expect(launcherText).toMatch(/COMPOSE_PROJECT="tenkacloud-local"/);
  });

  it("should use the pinned COMPOSE for every compose invocation", () => {
    // `docker compose` を直接叩く経路が残っていると、そこだけ project が揺れる。
    const directCalls = launcherText
      .split("\n")
      .filter((line) => /(^|[^-])\bdocker compose\b/.test(line))
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => !line.includes("COMPOSE=") && !line.includes("docker compose version"))
      // ユーザーへの案内文に出てくる `docker compose -f ... logs` は実行ではない。
      .filter((line) => !line.includes("echo"));
    expect(
      directCalls,
      `pinned でない docker compose 呼び出し: ${directCalls.join(" | ")}`,
    ).toEqual([]);
  });
});

describe("reclaim_foreign_control_plane_container (#2963)", () => {
  it("should do nothing when no container exists", () => {
    const { status, removed, stderr } = reclaimWith({ existingProject: null });
    expect(status, stderr).toBe(0);
    expect(removed).toBe("");
  });

  it("should leave a container that already belongs to this project to compose", () => {
    // 同じ project のものは再利用も作り直しも compose の仕事。ここで消すと毎回作り直しになる。
    const { status, removed } = reclaimWith({ existingProject: "tenkacloud-local" });
    expect(status).toBe(0);
    expect(removed).toBe("");
  });

  it("should reclaim a container left behind by another directory's project", () => {
    const { status, removed, stderr } = reclaimWith({ existingProject: "saas-mode-verification" });
    expect(status).toBe(0);
    expect(removed).toContain("tenkacloud-local");
    // 何が起きたかを出す (= 黙って消さない)。
    expect(stderr).toContain("saas-mode-verification");
    // データが消えないことを言う。ここが伝わらないと利用者は再実行をためらう。
    expect(stderr).toContain("data");
  });

  it("should fail with a runnable recovery command when it cannot remove the container", () => {
    // 自動回収できない場合に docker の生エラーで終わらない、が受け入れ条件そのもの。
    const { status, stderr } = reclaimWith({
      existingProject: "saas-mode-verification",
      removeFails: true,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("docker rm -f tenkacloud-local");
    expect(stderr).toContain("make local");
  });
});
