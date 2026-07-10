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
const setupScript = readFileSync(join(REPO_ROOT, "scripts", "codespaces-setup.sh"), "utf8");
const bootstrap = readFileSync(join(REPO_ROOT, "scripts", "onboard-bootstrap.sh"), "utf8");
const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

describe("devcontainer postCreate", () => {
  it("should run the single setup script instead of a && chain", () => {
    const { postCreateCommand } = JSON.parse(devcontainer) as { postCreateCommand: string };
    expect(postCreateCommand).toBe("sh scripts/codespaces-setup.sh");
  });
});

describe("scripts/codespaces-setup.sh", () => {
  it("should run the pre-bun bootstrap with consent pre-approved", () => {
    expect(setupScript).toContain('sh "$repo_root/scripts/onboard-bootstrap.sh" --yes');
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

describe("scripts/onboard-bootstrap.sh", () => {
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
  it("local-portal should explain a missing vite instead of exiting 127", () => {
    expect(makefile).toContain(
      "Dependencies are not installed (vite is missing). Run 'make install' first.",
    );
  });

  it("local-onboard should reach a bun the bootstrap just installed", () => {
    expect(makefile).toMatch(
      /PATH="\$\$HOME\/\.bun\/bin:\$\$PATH" bun run scripts\/tenkacloud-onboard\.ts preflight/,
    );
  });
});
