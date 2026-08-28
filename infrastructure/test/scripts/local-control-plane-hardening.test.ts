import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const dockerfile = readFileSync(
  join(REPO_ROOT, "docker", "local-control-plane", "Dockerfile"),
  "utf8",
);
const compose = readFileSync(join(REPO_ROOT, "compose.local.yaml"), "utf8");
const prerequisites = readFileSync(
  join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh"),
  "utf8",
);

describe("Docker-only local control-plane hardening", () => {
  it("runs the long-lived process as the image's unprivileged bun user", () => {
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM oven/bun:1.3.11-alpine AS runtime"));

    expect(runtime).toContain('test "$(id -u bun)" = "1000"');
    expect(runtime).toContain("chown bun:bun /data");
    expect(runtime).toMatch(/USER bun[\s\S]*ENTRYPOINT/);
    expect(runtime.indexOf("USER bun")).toBeLessThan(runtime.indexOf("ENTRYPOINT"));
  });

  it("migrates persistent data ownership in a socket-less one-shot service", () => {
    const migration = compose.slice(
      compose.indexOf("local-data-permissions:"),
      compose.indexOf("  local:", compose.indexOf("local-data-permissions:")),
    );

    expect(migration).toContain('user: "0:0"');
    expect(migration).toContain('command: ["chown -R 1000:1000 /data"]');
    expect(migration).toContain("network_mode: none");
    expect(migration).toContain("- CHOWN");
    expect(migration).toContain("- DAC_OVERRIDE");
    expect(migration).not.toContain("docker.sock");
    expect(compose).toContain("condition: service_completed_successfully");
  });

  it("drops privileges and makes the main container filesystem read-only", () => {
    const local = compose.slice(
      compose.indexOf("  local:"),
      compose.indexOf("volumes:\n  tenkacloud"),
    );

    expect(local).toContain('user: "1000:1000"');
    expect(local).toContain("group_add:");
    expect(local).toContain("TENKACLOUD_DOCKER_SOCKET_GID");
    expect(local).toContain("read_only: true");
    expect(local).toContain("/tmp:rw,noexec,nosuid,nodev,mode=1777");
    expect(local).toContain("cap_drop:\n      - ALL");
    expect(local).toContain("no-new-privileges:true");
    expect(local).toContain("pids_limit: 512");
    expect(local).toContain(String.raw`test \"$$(id -u)\" -ne 0`);
    expect(local).toContain(":/var/run/docker.sock:ro");
  });

  it("derives the supplementary group from the active local Docker socket", () => {
    expect(prerequisites).toContain("tenkacloud_resolve_docker_socket_gid");
    expect(prerequisites).toContain("docker run --rm");
    expect(prerequisites).toContain("stat -c '%g'");
    expect(prerequisites).toContain("/tenkacloud-docker.sock");
    expect(prerequisites).toContain("non-root control plane needs that supplementary GID");
  });
});
