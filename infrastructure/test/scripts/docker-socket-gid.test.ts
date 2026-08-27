import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREREQUISITES = join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "tenkacloud-socket-gid-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

async function unixSocket(path: string): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
}

function resolveGid(uname: "Linux" | "Darwin", socket: string, override?: string): string {
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho '${uname}'\n`, { mode: 0o755 });
  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `. '${PREREQUISITES}'`,
      `TENKACLOUD_DOCKER_SOCKET='${socket}'`,
      override === undefined ? "" : `TENKACLOUD_DOCKER_SOCKET_GID='${override}'`,
      "tenkacloud_resolve_docker_socket_gid",
      'printf "%s" "$TENKACLOUD_DOCKER_SOCKET_GID"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return execFileSync("/bin/sh", [script], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
}

describe("Docker socket supplementary GID", () => {
  it("uses the real rootless/rootful socket group on Linux", async () => {
    const socket = join(sandbox, "docker.sock");
    const close = await unixSocket(socket);
    try {
      const expected = execFileSync("stat", ["-c", "%g", socket], { encoding: "utf8" }).trim();
      expect(resolveGid("Linux", socket)).toBe(expected);
    } finally {
      await close();
    }
  });

  it("uses the Docker Desktop/Colima VM socket group contract on macOS", () => {
    expect(resolveGid("Darwin", "/var/run/docker.sock")).toBe("0");
  });

  it("honours an explicit numeric GID for an unforeseen socket setup", () => {
    expect(resolveGid("Linux", "/missing/socket", "1234")).toBe("1234");
  });
});
