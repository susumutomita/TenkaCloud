import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function resolveGid(
  options: {
    readonly daemonGid?: string;
    readonly override?: string;
    readonly probeFails?: boolean;
  } = {},
): { readonly gid: string; readonly dockerCalls: string } {
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(sandbox, "docker.log");
  writeFileSync(dockerLog, "");
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$GID_TEST_DOCKER_LOG"',
      options.probeFails ? "exit 1" : `echo '${options.daemonGid ?? "991"}'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -e",
      `. '${PREREQUISITES}'`,
      "TENKACLOUD_DOCKER_SOCKET='/var/run/docker.sock'",
      options.override === undefined ? "" : `TENKACLOUD_DOCKER_SOCKET_GID='${options.override}'`,
      "tenkacloud_resolve_docker_socket_gid",
      'printf "%s" "$TENKACLOUD_DOCKER_SOCKET_GID"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const gid = execFileSync("/bin/sh", [script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, GID_TEST_DOCKER_LOG: dockerLog },
    encoding: "utf8",
  });
  return {
    gid,
    dockerCalls: readFileSync(dockerLog, "utf8"),
  };
}

describe("Docker socket supplementary GID", () => {
  it("uses the group of the socket as mounted inside the daemon VM", () => {
    const result = resolveGid({ daemonGid: "991" });
    expect(result.gid).toBe("991");
    expect(result.dockerCalls).toContain(
      "run --rm -v /var/run/docker.sock:/tenkacloud-docker.sock:ro busybox stat -c %g",
    );
  });

  it("accepts root-owned daemon sockets when that is what the mount exposes", () => {
    expect(resolveGid({ daemonGid: "0" }).gid).toBe("0");
  });

  it("honours an explicit numeric GID for an unforeseen socket setup", () => {
    const result = resolveGid({ override: "1234" });
    expect(result.gid).toBe("1234");
    expect(result.dockerCalls).toBe("");
  });

  it("fails closed when the daemon-side socket group cannot be measured", () => {
    expect(() => resolveGid({ probeFails: true })).toThrow();
  });

  it("rejects a non-numeric override", () => {
    expect(() => resolveGid({ override: "not-a-gid" })).toThrow();
  });
});
