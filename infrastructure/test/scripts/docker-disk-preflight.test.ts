import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREREQUISITES = join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh");
const LAUNCHER = join(REPO_ROOT, "scripts", "local", "docker-launcher.sh");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "tenkacloud-disk-preflight-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runDiskCheck(options: { readonly availableKiB?: number; readonly probeFails?: boolean }): {
  readonly status: number;
  readonly stdout: string;
} {
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      options.probeFails ? "exit 1" : "",
      "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      `echo 'overlay 50000000 1 ${options.availableKiB ?? 1000000} 1% /'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `. '${PREREQUISITES}'`,
      "tenkacloud_docker_disk_meets_floor",
      "status=$?",
      'printf "%s:%s" "$status" "${TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES:-unknown}"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const stdout = execFileSync("/bin/sh", [script], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  const [status] = stdout.split(":");
  return { status: Number(status), stdout };
}

describe("Docker VM disk preflight", () => {
  it("passes when the measured free space is above the image floor", () => {
    const result = runDiskCheck({ availableKiB: 1_000_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0:1024000000");
  });

  it("fails when free space is below the measured image floor", () => {
    const result = runDiskCheck({ availableKiB: 1 });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("1:1024");
  });

  it("returns unknown rather than a false failure when the probe is unavailable", () => {
    const result = runDiskCheck({ probeFails: true });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("2:unknown");
  });

  it("runs the disk preflight before catalog work and the full control-plane build", () => {
    const launcher = readFileSync(LAUNCHER, "utf8");
    const up = launcher.slice(launcher.indexOf("cmd_up()"), launcher.indexOf("cmd_down()"));

    expect(up.indexOf("preflight_docker_disk")).toBeGreaterThan(-1);
    expect(up.indexOf("preflight_docker_disk")).toBeLessThan(
      up.indexOf("ensure_problems_submodule"),
    );
    expect(up.indexOf("preflight_docker_disk")).toBeLessThan(up.indexOf("$COMPOSE build"));
    expect(launcher).toContain("TenkaCloud did not run either cleanup command");
  });
});
