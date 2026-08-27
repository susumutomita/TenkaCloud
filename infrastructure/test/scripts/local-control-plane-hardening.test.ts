import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const compose = readFileSync(join(REPO_ROOT, "compose.local.yaml"), "utf8");
const dockerfile = readFileSync(
  join(REPO_ROOT, "docker", "local-control-plane", "Dockerfile"),
  "utf8",
);

function serviceBody(name: string, nextMarker: string): string {
  const start = compose.indexOf(`  ${name}:`);
  expect(start, `${name} service missing`).toBeGreaterThan(-1);
  const end = compose.indexOf(nextMarker, start + 1);
  expect(end, `${name} service end marker missing`).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("local control-plane container hardening (#3096)", () => {
  const init = serviceBody("local-data-init", "\n  local:");
  const local = serviceBody("local", "\nvolumes:");

  it("pins a dedicated non-root runtime identity in the Dockerfile", () => {
    expect(dockerfile).toContain("ARG TENKACLOUD_UID=10001");
    expect(dockerfile).toContain("ARG TENKACLOUD_GID=10001");
    expect(dockerfile).toContain("adduser -S -D -H");
    expect(dockerfile).toContain("USER tenkacloud:tenkacloud");
  });

  it("runs the participant-facing control plane as that non-root identity", () => {
    expect(local).toContain('user: "10001:10001"');
    expect(local).toContain('"${TENKACLOUD_DOCKER_SOCKET_GID:-0}"');
    expect(local).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(local).toContain("no-new-privileges:true");
    expect(local).toContain("read_only: true");
    expect(local).toContain("/tmp:rw,nosuid,nodev");
    expect(local).toContain("HOME: /tmp/tenkacloud-home");
    expect(local).not.toContain("privileged: true");
  });

  it("keeps existing-volume ownership migration isolated from Docker authority", () => {
    expect(init).toContain('user: "0:0"');
    expect(init).toContain("network_mode: none");
    expect(init).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(init).toMatch(/cap_add:\s*\n\s*- CHOWN/);
    expect(init).toContain("no-new-privileges:true");
    expect(init).toContain("read_only: true");
    expect(init).toContain("chown -R 10001:10001 /data");
    expect(init).not.toContain("docker.sock");
  });

  it("does not make the Docker socket world writable as a permission workaround", () => {
    const preflight = readFileSync(
      join(REPO_ROOT, "scripts", "local", "docker-socket-gid-preflight.sh"),
      "utf8",
    );
    expect(preflight).toContain("TENKACLOUD_DOCKER_SOCKET_GID");
    expect(preflight).toContain("stat -c '%g'");
    expect(preflight).not.toMatch(/chmod\s+(?:0?666|a\+rw).*docker/i);
  });
});
