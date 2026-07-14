import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A fresh Codespace must reach a working `make local` with zero manual steps.
 * The chain that guarantees that has three seams this file pins:
 *   1. devcontainer postCreate runs ONE script (codespaces-setup.sh), not a
 *      `cmd && cmd` chain — a bun installed mid-chain is invisible to the
 *      later links (PATH was resolved before the install) and the chain used
 *      to abort, leaving no dependencies and no problems/ submodule.
 *   2. Both the setup script and the bootstrap export ~/.bun/bin onto PATH
 *      right after a possible bun install, before anything calls `bun`.
 *   3. `make local-portal` fails with an actionable message when vite is
 *      missing instead of the bare `vite: command not found` (exit 127).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const devcontainer = readFileSync(join(REPO_ROOT, ".devcontainer", "devcontainer.json"), "utf8");
const setupScript = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "codespaces-setup.sh"),
  "utf8",
);
const bootstrap = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "onboard-bootstrap.sh"),
  "utf8",
);
const startLocalScript = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "codespaces-start-local.sh"),
  "utf8",
);
const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

describe("devcontainer postCreate", () => {
  it("should run the single setup script instead of a && chain", () => {
    const { postCreateCommand } = JSON.parse(devcontainer) as { postCreateCommand: string };
    expect(postCreateCommand).toBe("sh scripts/onboard/codespaces-setup.sh");
  });

  it("should auto-start local play on container start so the learner types nothing", () => {
    // The zero-manual-steps promise needs an auto-START, not just an auto-install:
    // a non-technical learner opens the Codespace to an empty port-5175 preview
    // unless something runs `make local` for them. postStart does exactly that.
    const { postStartCommand } = JSON.parse(devcontainer) as { postStartCommand: string };
    expect(postStartCommand).toBe("sh scripts/onboard/codespaces-start-local.sh");
  });

  it("should disable git-lfs autoPull so its hook install cannot abort postCreate", () => {
    // The universal:noble base image bundles the git-lfs feature, whose
    // pull-git-lfs-artifacts.sh runs `git lfs update` on create. That collides
    // with the Codespaces fork post-commit hook ("hook already exists"), exits
    // non-zero, and the devcontainer CLI then SKIPS our postCreateCommand — the
    // whole setup never runs. This repo has no LFS files, so autoPull:false
    // skips that pull entirely and loses nothing.
    const { features } = JSON.parse(devcontainer) as {
      features: Record<string, { autoPull?: boolean }>;
    };
    const gitLfs = features["ghcr.io/devcontainers/features/git-lfs:1"];
    expect(gitLfs, "git-lfs feature must be declared to override its options").toBeDefined();
    expect(gitLfs.autoPull).toBe(false);
  });
});

describe("scripts/onboard/codespaces-setup.sh", () => {
  it("should run the pre-bun bootstrap with consent pre-approved", () => {
    expect(setupScript).toContain('sh "$repo_root/scripts/onboard/onboard-bootstrap.sh" --yes');
  });

  it("should export ~/.bun/bin onto PATH before the first bun invocation", () => {
    const pathExport = setupScript.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const firstBunRun = setupScript.indexOf('bun run "$repo_root');
    expect(pathExport).toBeGreaterThan(-1);
    expect(firstBunRun).toBeGreaterThan(pathExport);
  });

  it("should run the preflight (submodule + Docker diagnosis) with --yes", () => {
    expect(setupScript).toContain(
      'bun run "$repo_root/scripts/tenkacloud-onboard.ts" preflight --yes',
    );
  });

  it("should install workspace dependencies (vite for the portal)", () => {
    expect(setupScript).toContain('make -C "$repo_root" install');
  });

  it("should stop on the first failure so a broken setup is loud", () => {
    expect(setupScript).toMatch(/^set -eu$/m);
  });
});

describe("scripts/onboard/codespaces-start-local.sh", () => {
  it("should start `make local` detached so the lifecycle step returns immediately", () => {
    // nohup + & keeps the portal alive past this shell and lets the Codespace
    // finish attaching (blocking here would hang the whole start).
    expect(startLocalScript).toMatch(/nohup make -C "\$repo_root" local .*&\s*$/m);
  });

  it("should export ~/.bun/bin onto PATH before invoking make (make local needs bun)", () => {
    const pathExport = startLocalScript.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const makeRun = startLocalScript.indexOf("nohup make");
    expect(pathExport).toBeGreaterThan(-1);
    expect(makeRun).toBeGreaterThan(pathExport);
  });

  it("should stop on the first failure so a broken start is loud", () => {
    expect(startLocalScript).toMatch(/^set -eu$/m);
  });
});

describe("scripts/onboard/onboard-bootstrap.sh", () => {
  it("should put a just-installed bun onto this shell's PATH before re-checking", () => {
    const install = bootstrap.indexOf('sh -c "$bun_cmd"');
    const pathExport = bootstrap.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const recheck = bootstrap.lastIndexOf("command -v bun");
    expect(install).toBeGreaterThan(-1);
    expect(pathExport).toBeGreaterThan(install);
    expect(recheck).toBeGreaterThan(pathExport);
  });
});

describe("Makefile local-play guards", () => {
  it("ensure-deps should auto-run make install when vite is missing (not just error out)", () => {
    // The ensure-deps recipe must install on demand — matched loosely so
    // whitespace/formatting can change without breaking the intent check.
    expect(makefile).toMatch(/ensure-deps:/);
    expect(makefile).toMatch(/vite is missing\)\s*—\s*running 'make install' first/);
    expect(makefile).toMatch(/\$\(MAKE\) install/);
  });

  it("make local should ensure deps before starting (single self-healing entry point)", () => {
    const local = makefile.slice(makefile.indexOf("\nlocal:"));
    expect(local).toMatch(/\$\(MAKE\) ensure-deps/);
  });

  it("local-portal should self-heal missing deps via ensure-deps rather than exiting 127", () => {
    const portal = makefile.slice(makefile.indexOf("\nlocal-portal:"));
    expect(portal.slice(0, 400)).toMatch(/\$\(MAKE\) ensure-deps/);
  });

  it("local-onboard should reach a bun the bootstrap just installed", () => {
    expect(makefile).toMatch(
      /PATH="\$\$HOME\/\.bun\/bin:\$\$PATH" bun run scripts\/tenkacloud-onboard\.ts preflight/,
    );
  });
});
