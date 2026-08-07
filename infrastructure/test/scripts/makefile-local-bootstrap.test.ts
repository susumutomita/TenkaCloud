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
