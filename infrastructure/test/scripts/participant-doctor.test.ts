import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProfile } from "../../../scripts/local/profiles";

/**
 * Regression coverage for the participant-facing doctor.
 *
 * The important boundary is executable, not documentary: the PATH used here
 * deliberately has no Bun, Node, or node_modules. A fake Docker CLI lets the
 * test prove the same Compose-v2/daemon/context contract as `make local`
 * without touching the host daemon or pulling an image.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const DOCTOR = join(REPO_ROOT, "scripts", "local", "doctor.sh");
const PREREQUISITES = join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh");
const MAKEFILE = join(REPO_ROOT, "Makefile");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "tenkacloud-participant-doctor-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function prepareRepo(): {
  readonly root: string;
  readonly bin: string;
  readonly dockerLog: string;
} {
  const root = join(sandbox, "repo");
  const bin = join(sandbox, "bin");
  const localScripts = join(root, "scripts", "local");
  mkdirSync(localScripts, { recursive: true });
  mkdirSync(join(root, "problems", "challenges"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(MAKEFILE, join(root, "Makefile"));
  copyFileSync(DOCTOR, join(localScripts, "doctor.sh"));
  copyFileSync(PREREQUISITES, join(localScripts, "docker-prerequisites.sh"));
  writeFileSync(join(root, "problems", "challenges", ".ready"), "fixture\n");

  writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'git version 2.51.0'\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker-compose"), "#!/bin/sh\necho 'docker-compose version 1.29.2'\n", {
    mode: 0o755,
  });
  writeFileSync(join(bin, "uname"), '#!/bin/sh\necho "$' + '{DOCTOR_TEST_UNAME:-Darwin}"\n', {
    mode: 0o755,
  });

  const dockerLog = join(sandbox, "docker.log");
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$DOCTOR_TEST_DOCKER_LOG"',
      'if [ "$1" = "--version" ]; then',
      "  echo 'Docker version 29.0.0, build fixture'",
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "compose version" ]; then',
      '  [ "$' + '{DOCTOR_TEST_COMPOSE_FAIL:-0}" = "1" ] && exit 1',
      "  echo 'Docker Compose version v2.40.0'",
      "  exit 0",
      "fi",
      'if [ "$1" = "info" ]; then',
      '  [ "$' + '{DOCTOR_TEST_DAEMON_FAIL:-0}" = "1" ] && exit 1',
      '  if [ "$' + '{2:-}" = "--format" ]; then',
      '    printf "%s\\t%s\\t29.0.0\\tDocker Desktop\\taarch64\\n" "$' +
        '{DOCTOR_TEST_CPUS:-4}" "$' +
        '{DOCTOR_TEST_MEMORY:-4090956349}"',
      "  fi",
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "context inspect" ]; then',
      '  echo "$' + '{DOCTOR_TEST_ENDPOINT:-unix:///var/run/docker.sock}"',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3 $4" = "run --rm busybox df" ]; then',
      "  echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      '  printf "overlay 50000000 1 %s 1%% /\\n" "$' +
        '{DOCTOR_TEST_DISK_AVAILABLE_KIB:-42513524}"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { root, bin, dockerLog };
}

interface RunOptions {
  readonly profile?: "minimum" | "recommended" | "full" | "unknown";
  readonly probeDisk?: boolean;
  readonly composeFails?: boolean;
  readonly daemonFails?: boolean;
  readonly endpoint?: string;
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly diskAvailableKiB?: number;
}

function runDoctor(options: RunOptions = {}): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dockerCalls: readonly string[];
} {
  const { root, bin, dockerLog } = prepareRepo();
  const args = ["doctor"];
  if (options.profile !== undefined) args.push(`PROFILE=${options.profile}`);
  if (options.probeDisk) args.push("PROBE_DISK=1");
  const result = spawnSync("/usr/bin/make", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      // /usr/bin and /bin provide make/sh/sed/awk/ls. Bun is deliberately absent.
      PATH: `${bin}:/usr/bin:/bin`,
      DOCTOR_TEST_DOCKER_LOG: dockerLog,
      DOCTOR_TEST_COMPOSE_FAIL: options.composeFails ? "1" : "0",
      DOCTOR_TEST_DAEMON_FAIL: options.daemonFails ? "1" : "0",
      DOCTOR_TEST_ENDPOINT: options.endpoint ?? "unix:///var/run/docker.sock",
      DOCTOR_TEST_CPUS: String(options.cpus ?? 4),
      DOCTOR_TEST_MEMORY: String(options.memoryBytes ?? 4_090_956_349),
      DOCTOR_TEST_DISK_AVAILABLE_KIB: String(options.diskAvailableKiB ?? 42_513_524),
      DOCTOR_TEST_UNAME: "Darwin",
    },
  });
  let dockerCalls: readonly string[] = [];
  try {
    dockerCalls = readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
  } catch {
    dockerCalls = [];
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    dockerCalls,
  };
}

describe("make doctor — Docker-only participant contract", () => {
  it("should pass with Git/Make/Docker/Compose v2 and no Bun on PATH", () => {
    const result = runDoctor({ profile: "recommended" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("participant prerequisites (Docker-only)");
    expect(result.stdout).toContain("Docker Compose v2");
    expect(result.stdout).toContain(
      "Portal host reachability — attempted after startup by make local",
    );
    expect(result.stdout).toContain("neither curl nor wget is available");
    expect(result.stdout).toContain("All pre-start participant prerequisites are satisfied");
    expect(result.stdout).toContain("attempt Portal host reachability after startup");
    expect(result.stdout).not.toContain("Bun");
  });

  it("should require the docker compose v2 plugin, not standalone docker-compose", () => {
    const result = runDoctor({ composeFails: true });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Docker Compose v2");
    expect(result.stdout).toContain("plugin did not answer");
  });

  it("should fail when the daemon is unreachable and skip the context check", () => {
    const result = runDoctor({ daemonFails: true });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Docker daemon — not reachable");
    expect(result.stdout).toContain("Docker context — not checked");
    expect(result.dockerCalls.some((call) => call.startsWith("context inspect"))).toBe(false);
  });

  it("should reject a remote Docker context just like make local", () => {
    const result = runDoctor({ endpoint: "tcp://10.0.0.2:2375" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("remote endpoint tcp://10.0.0.2:2375");
    expect(result.stderr).toContain("local Docker daemon reachable over a Unix socket");
  });

  it("should not pull busybox unless PROBE_DISK=1 was requested", () => {
    const normal = runDoctor({ profile: "minimum" });
    const probed = runDoctor({ profile: "minimum", probeDisk: true });

    expect(normal.status, normal.stderr).toBe(0);
    expect(normal.dockerCalls.some((call) => call.startsWith("run --rm busybox"))).toBe(false);
    expect(probed.status, probed.stderr).toBe(0);
    expect(probed.dockerCalls.some((call) => call.startsWith("run --rm busybox"))).toBe(true);
    expect(probed.stdout).toContain("Docker VM free disk");
  });

  it("should keep below-measurement resource warnings advisory", () => {
    const result = runDoctor({
      profile: "minimum",
      probeDisk: true,
      cpus: 1,
      memoryBytes: 1024 ** 3,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Result: WARN");
    expect(result.stdout).toContain("untested rather than known to fail");
  });

  it("should fail when an opt-in disk probe finds less than the measured hard floor", () => {
    const result = runDoctor({
      profile: "minimum",
      probeDisk: true,
      diskAvailableKiB: 1,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Result: FAIL");
    expect(result.stdout).toContain("image cannot finish materialising");
    expect(result.stdout).not.toContain("All pre-start participant prerequisites are satisfied");
    expect(result.stderr).toContain("measured hard requirement");
  });

  it("should not recommend the Bun-only benchmark as a participant prerequisite fix", () => {
    const result = runDoctor({ profile: "recommended" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no pass/fail threshold is published");
    expect(result.stdout).not.toContain("make local-measure");
  });

  it("should reject an unknown profile before invoking Docker", () => {
    const result = runDoctor({ profile: "unknown" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown profile");
    expect(result.dockerCalls).toEqual([]);
  });
});

function caseBlock(script: string, profile: string, nextProfile?: string): string {
  const start = script.indexOf(`    ${profile})`);
  expect(start, `${profile} case missing`).toBeGreaterThan(-1);
  const end =
    nextProfile === undefined
      ? script.indexOf("      ;;", start)
      : script.indexOf(`    ${nextProfile})`, start);
  expect(end, `${profile} case end missing`).toBeGreaterThan(start);
  return script.slice(start, end);
}

function numberAssignment(block: string, name: string): number | undefined {
  const match = block.match(new RegExp(`^\\s*${name}=([0-9]+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

describe("participant doctor profile table", () => {
  const script = readFileSync(DOCTOR, "utf8");

  it("should keep every duplicated measured number in parity with the typed profiles", () => {
    const minimum = findProfile("minimum");
    const recommended = findProfile("recommended");
    if (!minimum || !recommended) throw new Error("published profiles are missing");
    const minimumBlock = caseBlock(script, "minimum", "recommended");
    const recommendedBlock = caseBlock(script, "recommended", "full");
    const verified = minimum.requirements.verifiedConfiguration;
    if (!verified) throw new Error("minimum profile measurement is missing");

    expect(numberAssignment(minimumBlock, "doctor_profile_concurrency")).toBe(
      minimum.concurrentProblems,
    );
    expect(numberAssignment(minimumBlock, "doctor_profile_verified_cpus")).toBe(
      verified.dockerCpus,
    );
    expect(numberAssignment(minimumBlock, "doctor_profile_verified_memory")).toBe(
      verified.dockerMemoryBytes,
    );
    expect(numberAssignment(minimumBlock, "doctor_profile_observed_memory")).toBe(
      verified.observedMemBytes,
    );
    expect(numberAssignment(minimumBlock, "doctor_profile_disk_floor")).toBe(
      minimum.requirements.diskFloor?.bytes,
    );
    expect(numberAssignment(recommendedBlock, "doctor_profile_concurrency")).toBe(
      recommended.concurrentProblems,
    );
    expect(numberAssignment(recommendedBlock, "doctor_profile_disk_floor")).toBe(
      recommended.requirements.diskFloor?.bytes,
    );
  });
});

describe("shared Docker checks", () => {
  it("should be sourced by both participant entry points", () => {
    const makeLocal = readFileSync(
      join(REPO_ROOT, "scripts", "local", "docker-launcher.sh"),
      "utf8",
    );
    const doctor = readFileSync(DOCTOR, "utf8");

    expect(makeLocal).toContain("scripts/local/docker-prerequisites.sh");
    expect(makeLocal).toContain('tenkacloud_require_docker "make local"');
    expect(doctor).toContain("scripts/local/docker-prerequisites.sh");
    expect(doctor).toContain("tenkacloud_resolve_docker_socket");
  });
});
