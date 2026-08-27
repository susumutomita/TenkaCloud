import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PREFLIGHT = join(REPO_ROOT, "scripts", "local", "docker-host-network-preflight.sh");
const LAUNCHER = join(REPO_ROOT, "scripts", "local", "docker-launcher.sh");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "tenkacloud-host-network-preflight-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runPreflight(options: {
  readonly operatingSystem?: string;
  readonly context?: string;
  readonly setting?: boolean | "missing" | "unknown";
}): { readonly status: number; readonly output: string } {
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "info --format" ]; then',
      `  echo '${options.operatingSystem ?? "Docker Desktop"}'`,
      'elif [ "$1 $2" = "context show" ]; then',
      `  echo '${options.context ?? "desktop-linux"}'`,
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });

  if (options.setting !== "missing") {
    const settingsDir = join(home, "Library", "Group Containers", "group.com.docker");
    mkdirSync(settingsDir, { recursive: true });
    const body =
      options.setting === "unknown"
        ? JSON.stringify({ anotherSetting: true })
        : JSON.stringify({ hostNetworkingEnabled: options.setting ?? true });
    writeFileSync(join(settingsDir, "settings-store.json"), body);
  }

  const script = join(sandbox, "run.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `. '${PREFLIGHT}'`,
      "tenkacloud_preflight_docker_desktop_host_networking",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const output = execFileSync("/bin/sh", [script], {
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
    };
  }
}

describe("Docker Desktop host-networking preflight (#3095)", () => {
  it("fails before build when active Docker Desktop explicitly disables host networking", () => {
    const result = runPreflight({ setting: false });
    expect(result.status).toBe(1);
    expect(result.output).toContain("host networking is disabled");
    expect(result.output).toContain("Settings > Resources > Network > Enable host networking");
    expect(result.output).toContain("#3097");
  });

  it("passes when active Docker Desktop has host networking enabled", () => {
    const result = runPreflight({ setting: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain("host networking: enabled");
  });

  it("does not mistake Colima for an installed but inactive Docker Desktop", () => {
    const result = runPreflight({
      operatingSystem: "Ubuntu 24.04",
      context: "colima",
      setting: false,
    });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("host networking is disabled");
  });

  it("warns and continues when Docker Desktop settings are not readable", () => {
    const result = runPreflight({ setting: "missing" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("setting could not be read");
  });

  it("warns and continues when the Desktop setting shape is unknown", () => {
    const result = runPreflight({ setting: "unknown" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("setting was not recognizable");
  });

  it("runs only on the up path before catalog work and the full build", () => {
    const launcher = readFileSync(LAUNCHER, "utf8");
    const upStart = launcher.indexOf("cmd_up() {");
    const downStart = launcher.indexOf("cmd_down() {");
    const statusStart = launcher.indexOf("cmd_status() {");
    const up = launcher.slice(upStart, downStart);
    const down = launcher.slice(downStart, statusStart);
    const status = launcher.slice(statusStart);

    expect(up.indexOf("tenkacloud_preflight_docker_desktop_host_networking")).toBeGreaterThan(
      up.indexOf("preflight_docker_disk"),
    );
    expect(up.indexOf("tenkacloud_preflight_docker_desktop_host_networking")).toBeLessThan(
      up.indexOf("ensure_problems_submodule"),
    );
    expect(up.indexOf("tenkacloud_preflight_docker_desktop_host_networking")).toBeLessThan(
      up.indexOf("$COMPOSE build"),
    );
    expect(down).not.toContain("tenkacloud_preflight_docker_desktop_host_networking");
    expect(status).not.toContain("tenkacloud_preflight_docker_desktop_host_networking");
  });
});
