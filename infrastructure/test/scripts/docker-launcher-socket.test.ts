import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `make local` の control plane は daemon の socket を bind-mount して問題コンテナを起こす。
 * mount の source を解決するのが `resolve_docker_socket` で、ここが外れると image が build
 * できてもコンテナが起動しない。
 *
 * 元の実装は context の endpoint (= **ホスト側**のパス) をそのまま source にしていた。これは
 * daemon が CLI と同じファイルシステムにいる前提であり、Linux (rootless を含む) では正しい。
 * macOS では成立しない — Docker Desktop / Colima / Rancher Desktop のどれでも daemon は VM の
 * 中にいて、bind-mount の source は **daemon 側**で解決される。Colima で実測した失敗:
 *
 *   error while creating mount source path '/Users/<me>/.colima/default/docker.sock':
 *   mkdir ...: operation not supported
 *
 * ($HOME は virtiofs で VM に見えているので「無い」のではなく、socket を bind-mount できない。)
 *
 * この file は解決結果そのものを pin する。source 文字列の grep では、どのパスに倒れるかまでは
 * 分からない。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const LAUNCHER = join(REPO_ROOT, "scripts", "local", "docker-launcher.sh");

/**
 * launcher から `resolve_docker_socket` だけを取り出す。 script 末尾には `up|down|status` の
 * dispatch があり、 まるごと source すると usage で exit してしまう。
 */
function resolveDockerSocketSource(): string {
  const text = readFileSync(LAUNCHER, "utf8");
  const start = text.indexOf("resolve_docker_socket() {");
  expect(start, "resolve_docker_socket() が launcher に見つからない").toBeGreaterThan(-1);
  const end = text.indexOf("\n}\n", start);
  expect(end, "resolve_docker_socket() の終端が見つからない").toBeGreaterThan(start);
  return text.slice(start, end + 3);
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "docker-launcher-socket-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** `uname -s` と `docker context inspect` を差し替えて関数を走らせ、解決結果を返す。 */
function resolveWith(options: {
  readonly uname: string;
  readonly endpoint: string;
  readonly preset?: string;
}): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const bin = join(sandbox, "bin");
  execFileSync("mkdir", ["-p", bin]);

  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho '${options.uname}'\n`, { mode: 0o755 });
  // context inspect 以外の docker 呼び出しは、この関数からは起きない。
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho '${options.endpoint}'\n`, { mode: 0o755 });

  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -eu",
      resolveDockerSocketSource(),
      "resolve_docker_socket",
      'printf "%s" "$TENKACLOUD_DOCKER_SOCKET"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: sandbox,
  };
  if (options.preset !== undefined) env.TENKACLOUD_DOCKER_SOCKET = options.preset;

  try {
    const stdout = execFileSync("/bin/sh", [script], { env, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** `-S` 判定を通すために本物の unix socket を作る。 */
async function createUnixSocket(path: string): Promise<() => void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return () => server.close();
}

describe("resolve_docker_socket", () => {
  it("should mount the in-VM socket on macOS, not the host-side path the context reports", () => {
    // Colima が報告するホスト側 proxy socket。 これを daemon に渡すと mount source を VM 内で
    // 掘ろうとして operation not supported になる。
    const result = resolveWith({
      uname: "Darwin",
      endpoint: "unix:///Users/someone/.colima/default/docker.sock",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/var/run/docker.sock");
  });

  it("should reach the macOS answer without requiring that socket to exist on the host", () => {
    // /var/run/docker.sock は VM の中にしか無い。 ホスト側の `-S` 判定を通す作りだと、
    // macOS では必ず「socket が無い」で止まる。
    const result = resolveWith({
      uname: "Darwin",
      endpoint: "unix:///Users/someone/Library/Containers/com.docker.docker/Data/docker.raw.sock",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/var/run/docker.sock");
  });

  it("should keep honouring the active context on Linux, where the daemon shares the filesystem", async () => {
    // rootless Docker は $XDG_RUNTIME_DIR に socket を置く。 ここを /var/run に倒すと、
    // preflight は通るのに問題コンテナが 1 つも起動しない (= 元の実装が直した回帰)。
    const socketPath = join(sandbox, "rootless.sock");
    const close = await createUnixSocket(socketPath);
    try {
      const result = resolveWith({ uname: "Linux", endpoint: `unix://${socketPath}` });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(socketPath);
    } finally {
      close();
    }
  });

  it("should fail loudly on Linux when the context points at a socket that is not there", () => {
    const result = resolveWith({
      uname: "Linux",
      endpoint: `unix://${join(sandbox, "absent.sock")}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no socket exists there");
  });

  it("should let an explicit override win, so an unforeseen Docker setup has a way out", () => {
    for (const uname of ["Darwin", "Linux"]) {
      const result = resolveWith({
        uname,
        endpoint: "unix:///Users/someone/.colima/default/docker.sock",
        preset: "/tmp/my-own.sock",
      });

      expect(result.status, uname).toBe(0);
      expect(result.stdout, uname).toBe("/tmp/my-own.sock");
    }
  });

  it("should reject a remote daemon rather than resolve this repo's paths on another machine", () => {
    const result = resolveWith({ uname: "Linux", endpoint: "tcp://10.0.0.2:2375" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unix socket");
  });
});
