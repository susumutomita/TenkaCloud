import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const PREFLIGHT = join(REPO_ROOT, "scripts", "local", "docker-runtime-preflight.sh");
const launcher = readFileSync(join(REPO_ROOT, "scripts", "local", "docker-launcher.sh"), "utf8");

type RunResult = { status: number | null; stdout: string; stderr: string };

interface Scenario {
  readonly disk?: "ok" | "full" | "unavailable";
  readonly operatingSystem?: string;
  readonly context?: string;
  readonly desktopSetting?: boolean | "missing";
}

function runPreflight(scenario: Scenario): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "tc-local-preflight-"));
  try {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });

    const settingsDir = join(home, "Library", "Group Containers", "group.com.docker");
    mkdirSync(settingsDir, { recursive: true });
    if (scenario.desktopSetting !== "missing") {
      writeFileSync(
        join(settingsDir, "settings-store.json"),
        JSON.stringify({ hostNetworkingEnabled: scenario.desktopSetting ?? true }),
      );
    }

    const docker = [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "info --format")',
      `    printf '%s\\n' '${scenario.operatingSystem ?? "Docker Desktop"}'`,
      "    ;;",
      '  "context show")',
      `    printf '%s\\n' '${scenario.context ?? "desktop-linux"}'`,
      "    ;;",
      '  "run --rm")',
      scenario.disk === "unavailable"
        ? "    exit 1"
        : scenario.disk === "full"
          ? "    printf '95 512000\\n'"
          : "    printf '42 10485760\\n'",
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n");
    writeFileSync(join(bin, "docker"), docker);
    chmodSync(join(bin, "docker"), 0o755);

    // Force the macOS settings path while keeping all real POSIX utilities available.
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
    chmodSync(join(bin, "uname"), 0o755);

    const script = `. "${PREFLIGHT}"; tenkacloud_local_start_preflight`;
    const result = spawnSync("sh", ["-eu", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Docker participant start preflight (#3093/#3095)", () => {
  it("fails before startup when the Docker VM disk is above the threshold", () => {
    const result = runPreflight({ disk: "full" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("95% used");
    expect(result.stderr).toContain("docker system df");
    expect(result.stderr).toContain("will not prune automatically");
  });

  it("continues when Docker VM disk measurement is unavailable", () => {
    const result = runPreflight({ disk: "unavailable" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Could not measure Docker VM disk usage");
  });

  it("fails fast when the active Docker Desktop setting is explicitly disabled", () => {
    const result = runPreflight({ desktopSetting: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("host networking is disabled");
    expect(result.stderr).toContain("Settings > Resources > Network > Enable host networking");
  });

  it("does not confuse Colima with an installed Docker Desktop", () => {
    const result = runPreflight({
      operatingSystem: "Ubuntu 24.04",
      context: "colima",
      desktopSetting: false,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("host networking is disabled");
  });

  it("continues with an explicit enabled Docker Desktop setting", () => {
    const result = runPreflight({ desktopSetting: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("host networking: enabled");
  });

  it("does not call the start-only preflight from cleanup/status", () => {
    const upStart = launcher.indexOf("cmd_up() {");
    const downStart = launcher.indexOf("cmd_down() {");
    const statusStart = launcher.indexOf("cmd_status() {");
    const up = launcher.slice(upStart, downStart);
    const down = launcher.slice(downStart, statusStart);
    const status = launcher.slice(statusStart);

    expect(up.indexOf("tenkacloud_local_start_preflight")).toBeGreaterThan(
      up.indexOf("require_docker"),
    );
    expect(up.indexOf("$COMPOSE build")).toBeGreaterThan(
      up.indexOf("tenkacloud_local_start_preflight"),
    );
    expect(down).not.toContain("tenkacloud_local_start_preflight");
    expect(status).not.toContain("tenkacloud_local_start_preflight");
  });
});
