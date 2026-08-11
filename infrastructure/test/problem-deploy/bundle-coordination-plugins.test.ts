import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleCoordinationPlugins } from "../../lib/utils/bundle-coordination-plugins";

/**
 * Issue #1420: synth 時の coordination plugin bundler。 SDK 解決を要しない
 * self-contained plugin で iteration + esbuild 出力を pin する (= 実 SDK inline は s3-plugin-importer
 * 側 + reference 問題で検証)。
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bundle-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeProblem(category: string, dir: string, body: object, pluginSrc?: string): void {
  const pdir = join(root, category, dir);
  mkdirSync(join(pdir, "coordination"), { recursive: true });
  writeFileSync(join(pdir, "metadata.json"), JSON.stringify(body));
  if (pluginSrc !== undefined) writeFileSync(join(pdir, "coordination", "router.ts"), pluginSrc);
}

describe("bundleCoordinationPlugins", () => {
  it("should esbuild-bundle a declared plugin into self-contained ESM keyed by problemId", () => {
    writeProblem(
      "battles",
      "router-battle",
      { id: "router-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      "const p = { initialState: () => ({}), validateOp: () => ({ ok: true }), applyOp: (s) => s, projectForTeam: (s) => s };\nexport default p;\n",
    );
    const out = bundleCoordinationPlugins(root);
    expect(Object.keys(out)).toEqual(["router-battle"]);
    expect(out["router-battle"]).toContain("export");
    expect(out["router-battle"]).toContain("validateOp");
  });

  it("should omit problems that do not declare coordination", () => {
    writeProblem("challenges", "plain", { id: "plain" });
    expect(bundleCoordinationPlugins(root)).toEqual({});
  });

  it("should skip a declared plugin whose file is missing (no throw)", () => {
    writeProblem("battles", "ghost", {
      id: "ghost",
      interTeamCoordination: { plugin: "coordination/router.ts" },
    });
    rmSync(join(root, "battles", "ghost", "coordination", "router.ts"), { force: true });
    expect(bundleCoordinationPlugins(root)).toEqual({});
  });
});
