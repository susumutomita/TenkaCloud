import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `make doctor` は image が build できてもコンテナが 1 つも起動しない状態を、起動前に捕まえたい。
 * 典型的な原因は「`containerd.io` を upgrade したのに daemon service を再起動していない」で、rootless の
 * user-managed `docker.service` は system service と違い upgrade で自動再起動されないため起きやすい。
 * 走っている古い containerd が、upgrade 済みの on-disk shim を毎回 exec し、ttrpc で食い違って
 * "failed to create shim" で全コンテナが落ちる。CLI・Compose・socket・`docker info` は全部応答するので
 * doctor は他が全部緑になり、原因に辿り着けない。
 *
 * `tenkacloud_docker_daemon_stale` は RUNNING containerd 版 (`docker version` の Components) と on-disk の
 * `containerd --version` を比べてこの状態を検出する。`containerd.io` は `docker-ce` (dockerd) と別 package
 * で独立に上がるため、比較対象は dockerd ではなく containerd。ここでは `docker` と `containerd` を stub して
 * 分岐を pin する。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREREQUISITES = join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "docker-daemon-stale-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * `docker` と `containerd` を stub して `tenkacloud_docker_daemon_stale` を走らせ、その exit code と、
 * 関数が埋める 2 つの version 変数を返す。`containerdVersionLine` を省くと `containerd` を PATH に置かない
 * (= Docker Desktop 相当) 状態を作る。`docker` stub は Components template 呼び出しに対し running 版を返す。
 */
function runStaleCheck(options: {
  readonly runningContainerd: string;
  readonly containerdVersionLine?: string;
}): { readonly status: number; readonly running: string; readonly ondisk: string } {
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });

  // `docker version --format '...Components...'` だけがこの関数から呼ばれる。
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho '${options.runningContainerd}'\n`, {
    mode: 0o755,
  });
  if (options.containerdVersionLine !== undefined) {
    writeFileSync(join(bin, "containerd"), `#!/bin/sh\necho '${options.containerdVersionLine}'\n`, {
      mode: 0o755,
    });
  }

  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -u",
      `. '${PREREQUISITES}'`,
      "tenkacloud_docker_daemon_stale",
      "status=$?",
      'printf "%s\\n%s\\n%s" "$status" "$TENKACLOUD_RUNNING_CONTAINERD_VERSION" "$TENKACLOUD_ONDISK_CONTAINERD_VERSION"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // PATH を stub の bin だけにして、本物の docker/containerd と、awk/tr のような外部依存を締め出す。
  // 後者が締め出されても関数が動くことが、POSIX 組み込みのみで解析している証拠になる。
  const stdout = execFileSync("/bin/sh", [script], {
    env: { PATH: bin },
    encoding: "utf8",
  });
  const [status, running, ondisk] = stdout.split("\n");
  return { status: Number(status), running, ondisk };
}

describe("tenkacloud_docker_daemon_stale", () => {
  it("returns 0 (stale) when the running containerd differs from the on-disk containerd", () => {
    const result = runStaleCheck({
      runningContainerd: "v2.2.5",
      containerdVersionLine: "containerd containerd v2.3.3 aad11006b869",
    });
    expect(result.status).toBe(0);
    expect(result.running).toBe("v2.2.5");
    expect(result.ondisk).toBe("v2.3.3");
  });

  it("returns 1 (healthy) when the running containerd matches the on-disk containerd", () => {
    const result = runStaleCheck({
      runningContainerd: "v2.3.3",
      containerdVersionLine: "containerd containerd v2.3.3 aad11006b869",
    });
    expect(result.status).toBe(1);
    expect(result.running).toBe("v2.3.3");
    expect(result.ondisk).toBe("v2.3.3");
  });

  it("returns 2 (skip) when containerd is not on PATH, e.g. Docker Desktop", () => {
    const result = runStaleCheck({ runningContainerd: "v2.3.3" });
    expect(result.status).toBe(2);
    expect(result.ondisk).toBe("");
  });

  it("returns 2 (skip) when the on-disk containerd version is unreadable", () => {
    const result = runStaleCheck({
      runningContainerd: "v2.3.3",
      containerdVersionLine: "",
    });
    expect(result.status).toBe(2);
    expect(result.ondisk).toBe("");
  });
});
