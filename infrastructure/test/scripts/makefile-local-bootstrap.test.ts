import { readFileSync } from "node:fs";
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
});

/**
 * [#2906 review] The crash-recovery teardown had two ways to quietly stop working,
 * both of which end in `make local-down` printing "progress cleared" over surviving
 * containers — the dishonest-success shape this change exists to remove:
 *   - `xargs -r` is a GNU extension. macOS's BSD xargs exits with "illegal option --
 *     r", the `|| true` swallows it, and every orphan survives. macOS is the platform
 *     this whole change came from, so this is pinned rather than trusted to review.
 *   - Treating a leftover `state.json` as a live `make local-dev` session disables the
 *     host-side sweep permanently after any past dev-session crash. Liveness must be
 *     established from the recorded PID and process identity (the same
 *     sha256("<pid>:<ps lstart>") the Bun side records, so PID reuse is rejected).
 */
describe("docker-launcher crash-recovery teardown (Issue #2906)", () => {
  const launcher = readFileSync(join(REPO_ROOT, "scripts", "local", "docker-launcher.sh"), "utf8");
  /** Comment lines explain what this file must NOT do, so match code only. */
  const code = launcher
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("should not use GNU-only xargs flags that BSD/macOS xargs rejects", () => {
    expect(code).not.toMatch(/xargs\s+-r\b/);
    expect(code).not.toContain("--no-run-if-empty");
  });

  it("should remove each orphan container and network with a POSIX loop", () => {
    expect(launcher).toMatch(/for orphan in \$orphans; do\s+docker rm -f "\$orphan"/);
    expect(launcher).toMatch(
      /for orphan_network in \$orphan_networks; do\s+docker network rm "\$orphan_network"/,
    );
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

  it("should gate the sweep on that liveness check rather than on the state file", () => {
    expect(launcher).toContain("if host_dev_session_is_live; then");
    expect(launcher).not.toMatch(/if \[ -f "\$\(host_dev_state_file\)" \]; then/);
  });
});
