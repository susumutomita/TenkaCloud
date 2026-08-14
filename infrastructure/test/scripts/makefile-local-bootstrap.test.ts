import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2907: on a fresh clone the CLI's static import graph needs external
 * packages, so `bun run tenkacloud local` fails module resolution before the
 * CLI's own dependency self-heal can run. Every make entry point that reaches
 * the Bun CLI must therefore run `ensure-deps` first, and `ensure-deps` must
 * turn a missing bun into the actionable next command instead of
 * "bun: command not found". Pinned here so `make local-onboard` → `make
 * local-dev` keeps working with no extra `make install` step.
 *
 * Issue #2906: `make local` (the participant path) no longer reaches the Bun
 * CLI at all — it delegates to the Docker-only launcher instead, which this
 * file also pins. `local-dev` is what inherited `local`'s old recipe body
 * (the developer Bun/Vite hot-reload path), and `local-up`/`local-portal`
 * stay on the Bun CLI unchanged (developer/scripts escape hatches).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

/** The recipe body of a target: lines after `name:` up to the next non-indented line. */
function recipeOf(target: string): string {
  const match = makefile.match(new RegExp(`^${target}:[^\\n]*\\n((?:[\\t#][^\\n]*\\n|\\n)*)`, "m"));
  expect(match, `target "${target}" not found`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("make local-dev bootstraps dependencies before the Bun CLI (Issue #2907)", () => {
  for (const target of ["local-dev", "local-up", "local-portal"]) {
    it(`should run ensure-deps before bun in "make ${target}"`, () => {
      const recipe = recipeOf(target);
      const ensureIndex = recipe.indexOf("$(MAKE) ensure-deps");
      const bunIndex = recipe.indexOf("bun run");
      expect(ensureIndex, `ensure-deps missing from "${target}"`).toBeGreaterThan(-1);
      expect(bunIndex, `bun run missing from "${target}"`).toBeGreaterThan(ensureIndex);
    });
  }

  it("should check for bun before installing dependencies in ensure-deps", () => {
    const recipe = recipeOf("ensure-deps");
    const bunCheck = recipe.indexOf("command -v bun");
    const install = recipe.indexOf("$(MAKE) install");
    expect(bunCheck, "bun presence check missing").toBeGreaterThan(-1);
    expect(install, "self-heal install missing").toBeGreaterThan(bunCheck);
  });

  it("should point a missing bun at make local-onboard and the reviewed installer", () => {
    const recipe = recipeOf("ensure-deps");
    expect(recipe).toContain("make local-onboard");
    expect(recipe).toContain("bash scripts/onboard/install-bun.sh");
  });
});

describe("make local is Docker-only and never reaches the Bun CLI (Issue #2906)", () => {
  for (const target of ["local", "local-down", "local-status"]) {
    it(`should delegate "make ${target}" to the Docker launcher, not ensure-deps/bun`, () => {
      const recipe = recipeOf(target);
      expect(recipe).toContain("scripts/local/docker-launcher.sh");
      expect(recipe).not.toContain("ensure-deps");
      expect(recipe).not.toContain("bun run");
    });
  }

  it("should run the participant doctor through POSIX shell without Bun", () => {
    const recipe = recipeOf("doctor");
    expect(recipe).toContain("scripts/local/doctor.sh");
    expect(recipe).not.toContain("command -v bun");
    expect(recipe).not.toContain("bun run");
    expect(recipe).not.toContain("ensure-deps");
  });

  it("should keep the Bun/mise diagnosis behind the developer-only target", () => {
    const recipe = recipeOf("doctor-dev");
    expect(recipe).toContain("command -v bun");
    expect(recipe).toContain("scripts/tenkacloud-onboard.ts doctor");
  });
});

/**
 * [#2906 round-4 audit] The launcher's host-side reachability probe is what turns a
 * "container healthy but invisible to the host" Docker Desktop misconfiguration into a
 * loud failure instead of a Portal URL that loads nothing. Three properties of that probe
 * were each wrong on the first attempt and each fail *silently* if reintroduced, so they
 * are pinned here rather than left to review:
 *   - proxy bypass: curl/wget honour http_proxy even for loopback, so without this an
 *     entirely healthy stack probes as unreachable in any proxied shell — a deterministic
 *     false failure that then blames Docker Desktop for it;
 *   - bounded wget: `-T` bounds one attempt, not the command (GNU wget retries 20x);
 *   - identity: port 5175 is also the host/dev path's default, so a leftover dev process
 *     answers the probe and would be reported as success — the exact false success the
 *     probe exists to catch.
 */
describe("docker-launcher host reachability probe (Issue #2906)", () => {
  const launcher = readFileSync(join(REPO_ROOT, "scripts", "local", "docker-launcher.sh"), "utf8");
  const probe = launcher.slice(
    launcher.indexOf("host_reachable() {"),
    launcher.indexOf("docker_desktop_host_networking_hint()"),
  );

  it("should bypass any HTTP proxy so a proxied shell cannot fake unreachability", () => {
    expect(probe).toContain("--noproxy");
    expect(probe).toMatch(/http_proxy=\s+HTTP_PROXY=/);
  });

  it("should bound the wget fallback instead of letting it retry with backoff", () => {
    expect(probe).toContain("--tries");
  });

  it("should confirm which server answered, not merely that one did", () => {
    expect(probe).toContain('"mode":"local"');
  });

  it("should treat a host with neither curl nor wget as unknown, not as failure", () => {
    expect(probe).toMatch(/return 2/);
  });

  it("should surface that unknown result instead of claiming host reachability", () => {
    const up = launcher.slice(launcher.indexOf("cmd_up() {"), launcher.indexOf("cmd_status() {"));

    expect(up).toContain('reachable_result" -eq 2');
    expect(up).toContain("host reachability unverified");
    expect(up).toContain("neither curl nor wget is installed");
    expect(up).toContain("is up and host-reachable");

    const status = launcher.slice(launcher.indexOf("cmd_status() {"));
    expect(status).toContain('status_reachable_result" -eq 2');
    expect(status).toContain("host reachability is unverified");
    expect(status).toContain("is running and host-reachable");
  });
});

/**
 * [#2906 review] The crash-recovery teardown — the branch that runs precisely when the
 * control plane died and its graceful in-container `down` could not — has several ways
 * to quietly stop reclaiming things while `make local-down` still prints "progress
 * cleared". That dishonest success is the shape this whole change exists to remove, and
 * none of it is visible in normal operation, so the behaviour is exercised rather than
 * eyeballed: the sweep is run against a stub `docker` and the calls it makes are
 * asserted, for both an empty and a populated orphan list.
 */
describe("docker-launcher crash-recovery teardown (Issue #2906)", () => {
  const launcher = readFileSync(join(REPO_ROOT, "scripts", "local", "docker-launcher.sh"), "utf8");

  /**
   * Run cmd_down's host-side sweep with `docker` replaced by a recorder. Returns the
   * argv of every docker call the sweep made, so both "removed what it should" and
   * "made no call at all when there was nothing to remove" are observable.
   */
  function runSweep(orphans: {
    containers: string[];
    volumes: { name: string; project: string }[];
    networks: string[];
  }): string[] {
    const dir = mkdtempSync(join(tmpdir(), "tc-sweep-"));
    try {
      const log = join(dir, "calls.log");
      const projects = join(dir, "projects");
      writeFileSync(
        projects,
        `${orphans.volumes.map((v) => `${v.name} ${v.project}`).join("\n")}\n`,
      );
      writeFileSync(
        join(dir, "docker"),
        [
          "#!/bin/sh",
          `echo "$@" >> "${log}"`,
          'case "$1 $2" in',
          `  "ps -aq") printf '%s\\n' ${orphans.containers.map((c) => `'${c}'`).join(" ")} ;;`,
          `  "volume ls") printf '%s\\n' ${orphans.volumes.map((v) => `'${v.name}'`).join(" ") || "''"} ;;`,
          `  "network ls") printf '%s\\n' ${orphans.networks.map((n) => `'${n}'`).join(" ") || "''"} ;;`,
          '  "volume inspect") ;;', // handled below by arg position
          "esac",
          // `docker volume inspect -f <fmt> <name>` → print that volume's project label
          'if [ "$1 $2" = "volume inspect" ]; then',
          '  for a in "$@"; do last="$a"; done',
          `  awk -v n="$last" '$1==n {print $2}' "${projects}"`,
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      // Only the sweep body: everything before it needs a real daemon. The end
      // marker also appears in the live-dev-session branch above, so search for it
      // from the sweep's own start rather than from the top of the file.
      const sweepStart = launcher.indexOf('orphans=$(docker ps -aq --filter "name=^tc-local-"');
      expect(sweepStart, "sweep start marker not found in launcher").toBeGreaterThan(-1);
      const sweepEnd = launcher.indexOf("$COMPOSE down --remove-orphans -v", sweepStart);
      expect(sweepEnd, "sweep end marker not found after start").toBeGreaterThan(sweepStart);
      const sweep = launcher.slice(sweepStart, sweepEnd);
      execFileSync("sh", ["-eu", "-c", sweep], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        stdio: "ignore",
      });
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("should remove every orphan container, volume, and network it finds", () => {
    const calls = runSweep({
      containers: ["c1", "c2"],
      volumes: [{ name: "tc-local-wp_db_data", project: "tc-local-wp" }],
      networks: ["n1"],
    });
    expect(calls).toContain("rm -f c1");
    expect(calls).toContain("rm -f c2");
    expect(calls).toContain("volume rm -f tc-local-wp_db_data");
    expect(calls).toContain("network rm n1");
  });

  it("should leave volumes belonging to another compose project alone", () => {
    const calls = runSweep({
      containers: [],
      volumes: [{ name: "someone-elses_data", project: "someone-elses-app" }],
      networks: [],
    });
    expect(calls.some((c) => c.startsWith("volume rm"))).toBe(false);
  });

  it("should make no removal call when there is nothing to reclaim", () => {
    const calls = runSweep({ containers: [], volumes: [], networks: [] });
    expect(calls.some((c) => c.includes("rm"))).toBe(false);
  });

  it("should decide a dev session is live from PID liveness, not file existence", () => {
    const liveness = launcher.slice(
      launcher.indexOf("host_dev_session_is_live() {"),
      launcher.indexOf("cmd_down() {"),
    );
    expect(liveness).toContain("ps -p");
    expect(liveness).toMatch(/Z\*\)/); // a zombie is not a live session
    expect(liveness).toContain("processIdentity"); // reject PID reuse like the Bun side
  });

  it("should mount the active context's socket, not a hardcoded rootful path", () => {
    // Rootless Docker's socket lives under $XDG_RUNTIME_DIR; a hardcoded
    // /var/run/docker.sock passes every preflight and then cannot start a problem.
    const compose = readFileSync(join(REPO_ROOT, "compose.local.yaml"), "utf8");
    // Built by concatenation so this file contains no literal shell placeholder.
    const socketMount = ["$", "{TENKACLOUD_DOCKER_SOCKET:-/var/run/docker.sock}"].join("");
    const prerequisites = readFileSync(
      join(REPO_ROOT, "scripts", "local", "docker-prerequisites.sh"),
      "utf8",
    );
    expect(compose).toContain(`${socketMount}:/var/run/docker.sock`);
    expect(launcher).toContain("docker-prerequisites.sh");
    expect(prerequisites).toContain("docker context inspect");
    expect(prerequisites).toContain("TENKACLOUD_DOCKER_SOCKET");
  });

  it("should gate the sweep on that liveness check rather than on the state file", () => {
    expect(launcher).toContain("if host_dev_session_is_live; then");
    expect(launcher).not.toMatch(/if \[ -f "\$\(host_dev_state_file\)" \]; then/);
  });
});
