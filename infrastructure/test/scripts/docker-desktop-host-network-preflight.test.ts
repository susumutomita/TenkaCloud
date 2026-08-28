import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const LAUNCHER = join(REPO_ROOT, "scripts", "local", "docker-launcher.sh");
const PREREQUISITES = join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh");
const COMPOSE = join(REPO_ROOT, "compose.local.yaml");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "tenkacloud-hostnet-preflight-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface LauncherOptions {
  readonly hostNetworkReachable?: boolean;
  readonly operatingSystem?: string;
  readonly probeStarts?: boolean;
}

function runLauncher(options: LauncherOptions = {}): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dockerCalls: readonly string[];
} {
  const root = join(sandbox, "repo");
  const bin = join(sandbox, "bin");
  const local = join(root, "scripts", "local");
  mkdirSync(local, { recursive: true });
  mkdirSync(join(root, "problems", "challenges"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(LAUNCHER, join(local, "docker-launcher.sh"));
  copyFileSync(PREREQUISITES, join(local, "docker-prerequisites.sh"));
  copyFileSync(COMPOSE, join(root, "compose.local.yaml"));
  writeFileSync(join(root, "problems", "challenges", ".ready"), "fixture\n");

  const dockerLog = join(sandbox, "docker.log");
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$HOSTNET_TEST_DOCKER_LOG"',
      'if [ "$1" = "--version" ]; then echo "Docker version 29.0.0"; exit 0; fi',
      'if [ "$1 $2" = "compose version" ]; then echo "Docker Compose version v2.40.0"; exit 0; fi',
      'if [ "$1 $2" = "info --format" ]; then echo "$HOSTNET_TEST_OPERATING_SYSTEM"; exit 0; fi',
      'if [ "$1" = "info" ]; then exit 0; fi',
      'if [ "$1 $2 $3 $4" = "run --rm busybox df" ]; then',
      "  echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      "  echo 'overlay 50000000 1 1000000 1% /'",
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "run -d" ]; then',
      '  [ "$HOSTNET_TEST_PROBE_STARTS" = "1" ] || exit 1',
      '  echo "probe-container-id"',
      "  exit 0",
      "fi",
      'if [ "$1" = "inspect" ]; then',
      '  case "$*" in *State.Health.Status*) echo "healthy" ;; esac',
      "  exit 0",
      "fi",
      'if [ "$1" = "rm" ]; then exit 0; fi',
      'if [ "$1" = "compose" ]; then exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *5175/healthz*) echo \'{"mode":"local"}\'; exit 0 ;;',
      "esac",
      options.hostNetworkReachable === false
        ? "exit 1"
        : "echo 'tenkacloud-host-network-preflight-ok'; exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const result = spawnSync("/bin/sh", [join(local, "docker-launcher.sh"), "up"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TENKACLOUD_DOCKER_SOCKET: join(sandbox, "fake-docker.sock"),
      HOSTNET_TEST_DOCKER_LOG: dockerLog,
      HOSTNET_TEST_OPERATING_SYSTEM: options.operatingSystem ?? "Docker Desktop",
      HOSTNET_TEST_PROBE_STARTS: options.probeStarts === false ? "0" : "1",
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    dockerCalls: readFileSync(dockerLog, "utf8").split("\n").filter(Boolean),
  };
}

describe("Docker Desktop host-networking preflight", () => {
  it("stops before the full image build when --network host is not host-reachable", () => {
    const result = runLauncher({ hostNetworkReachable: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("startup stopped before the build");
    expect(result.stderr).toContain("Docker Desktop >=4.34");
    expect(result.stderr).toContain("Settings > Resources > Network");
    expect(result.dockerCalls.some((call) => call.includes("--network host"))).toBe(true);
    expect(result.dockerCalls.some((call) => /compose .* build/.test(call))).toBe(false);
  });

  it("continues to build and reports the successful preflight when host networking works", () => {
    const result = runLauncher();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Docker Desktop host networking preflight: reachable");
    expect(result.stdout).toContain("host-reachable");
    expect(result.dockerCalls.some((call) => /compose .* build/.test(call))).toBe(true);
  });

  it("does not launch the host-network probe on a native Docker Engine", () => {
    const result = runLauncher({ operatingSystem: "Ubuntu 24.04.4 LTS" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerCalls.some((call) => call.includes("--network host"))).toBe(false);
    expect(result.dockerCalls.some((call) => /compose .* build/.test(call))).toBe(true);
  });

  it("continues with a warning when the temporary probe cannot start", () => {
    const result = runLauncher({ probeStarts: false });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("preflight container could not start");
    expect(result.stderr).toContain("instead of reporting a false failure");
    expect(result.dockerCalls.some((call) => /compose .* build/.test(call))).toBe(true);
  });

  it("keeps the preflight ordered before catalog setup and compose build", () => {
    const script = readFileSync(LAUNCHER, "utf8");
    const up = script.slice(script.indexOf("cmd_up()"), script.indexOf("cmd_down()"));

    expect(up.indexOf("docker_desktop_host_networking_preflight")).toBeLessThan(
      up.indexOf("ensure_problems_submodule"),
    );
    expect(up.indexOf("docker_desktop_host_networking_preflight")).toBeLessThan(
      up.indexOf("$COMPOSE build"),
    );
    expect(script).toContain('probe_name="tenkacloud-host-network-preflight-$$"');
    expect(script).toContain("sleep 15");
  });
});
