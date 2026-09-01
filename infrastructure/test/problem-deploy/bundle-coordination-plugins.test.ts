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

  /**
   * Issue #3154: the dispatcher Lambda that runs these bundles holds
   * `ssm:GetParameter` for the Turso control-data auth token, so a plugin that
   * could reach the AWS SDK — or spawn a process — could read and write every
   * tenant's control data. A probe proved `bundle: true` happily resolved
   * `@aws-sdk/client-ssm` out of the repository's node_modules, so the boundary
   * is enforced at bundle time, where it is free.
   */
  it("should reject a plugin importing a Node builtin outside the allowlist", () => {
    writeProblem(
      "battles",
      "escape-battle",
      { id: "escape-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      'import { execSync } from "node:child_process";\nexport default { applyOp: () => execSync("id") };\n',
    );
    expect(() => bundleCoordinationPlugins(root)).toThrow(
      /"node:child_process" \(in .*router\.ts\), which is not allowed/,
    );
  });

  it("should reject a plugin importing a package and name the file that wrote the import", () => {
    writeProblem(
      "battles",
      "pkg-battle",
      { id: "pkg-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      'import { boom } from "evil-pkg";\nexport default { applyOp: () => boom };\n',
    );
    const pkg = join(root, "node_modules", "evil-pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "evil-pkg", main: "index.js", type: "module" }),
    );
    writeFileSync(join(pkg, "index.js"), "export const boom = 1;\n");
    // The authored line, not one of the package's own transitive internals.
    expect(() => bundleCoordinationPlugins(root)).toThrow(
      /"evil-pkg" \(in .*coordination\/router\.ts\)/,
    );
  });

  it("should allow the plugin's own files, which bundling exists to inline", () => {
    writeProblem(
      "battles",
      "multifile-battle",
      { id: "multifile-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      'import { score } from "./scoring.ts";\nexport default { applyOp: () => score() };\n',
    );
    writeFileSync(
      join(root, "battles", "multifile-battle", "coordination", "scoring.ts"),
      "export const score = () => 30;\n",
    );
    expect(bundleCoordinationPlugins(root)["multifile-battle"]).toContain("30");
  });

  it("should reject a forbidden import that only a dependency makes", () => {
    // The SDK is allowed, but that does not make everything it pulls in allowed —
    // a compromised dependency is the same credential path as a compromised plugin.
    writeProblem(
      "battles",
      "dep-battle",
      { id: "dep-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      'import { defineCoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";\nexport default defineCoordinationPlugin({});\n',
    );
    const sdk = join(root, "node_modules", "@tenkacloud", "coordination-plugin-sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@tenkacloud/coordination-plugin-sdk",
        main: "index.js",
        type: "module",
      }),
    );
    writeFileSync(
      join(sdk, "index.js"),
      'import { execSync } from "node:child_process";\nexport const defineCoordinationPlugin = (p) => (execSync("id"), p);\n',
    );
    // No file the problem author wrote is at fault, so the dependency is named instead.
    expect(() => bundleCoordinationPlugins(root)).toThrow(
      /"node:child_process" \(in .*node_modules/,
    );
  });

  it("should allow node:crypto, which problem seed derivation needs", () => {
    writeProblem(
      "battles",
      "seed-battle",
      { id: "seed-battle", interTeamCoordination: { plugin: "coordination/router.ts" } },
      'import { createHash } from "node:crypto";\nexport default { applyOp: (s) => createHash("sha256").update(s).digest("hex") };\n',
    );
    expect(bundleCoordinationPlugins(root)["seed-battle"]).toContain("createHash");
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
