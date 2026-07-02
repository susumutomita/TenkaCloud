import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2206: the root `typecheck`/`test`/`test:coverage` scripts enumerate workspace
 * packages by hand (`bun run --filter <name> <script>`), so a new package under `packages`
 * with its own `test`/`typecheck` script can silently be left out of CI — exactly what
 * happened to `@tenkacloud/portal-plugin-sdk` and `@tenkacloud/problem-test`. This test
 * closes the blind spot class itself: every package under `packages` whose package.json
 * declares a `test`/`typecheck` script must have its name enumerated in the matching root
 * script.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

interface RootScripts {
  readonly typecheck: string;
  readonly test: string;
}

function rootScripts(): RootScripts {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: RootScripts;
  };
  return root.scripts;
}

function packagesWithScript(scriptName: "typecheck" | "test"): readonly string[] {
  const names: string[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, entry.name, "package.json");
    let pkg: { name?: unknown; scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue; // no package.json (e.g. a stray non-package directory)
    }
    if (typeof pkg.name === "string" && typeof pkg.scripts?.[scriptName] === "string") {
      names.push(pkg.name);
    }
  }
  return names;
}

describe("root package.json quality-gate enumeration (issue #2206)", () => {
  it("should list every packages/* with a typecheck script in the root typecheck script", () => {
    const { typecheck } = rootScripts();
    const missing = packagesWithScript("typecheck").filter(
      (name) => !typecheck.includes(`--filter ${name} typecheck`),
    );
    expect(missing).toEqual([]);
  });

  it("should list every packages/* with a test script in the root test script", () => {
    const { test } = rootScripts();
    const missing = packagesWithScript("test").filter(
      (name) => !test.includes(`--filter ${name} test`),
    );
    expect(missing).toEqual([]);
  });
});
