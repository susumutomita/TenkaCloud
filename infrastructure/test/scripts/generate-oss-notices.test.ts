import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildThirdPartyNotices,
  collectThirdPartyNotices,
  type NoticeWorkspace,
} from "../../../scripts/lib/oss-notices";

describe("oss notices generator", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "oss-notices-test-"));
    mkdirSync(join(tmpRoot, "node_modules"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeInstalledPackage(
    name: string,
    pkg: {
      readonly version?: string;
      readonly license?: unknown;
      readonly dependencies?: unknown;
      readonly optionalDependencies?: unknown;
    },
    licenseText?: string,
  ): void {
    const pkgDir = join(tmpRoot, "node_modules", ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...pkg }, null, 2),
    );
    if (licenseText !== undefined) writeFileSync(join(pkgDir, "LICENSE"), licenseText);
  }

  function workspace(dependencies: Record<string, string>): NoticeWorkspace {
    return { name: "@tenkacloud/test-app", dir: tmpRoot, dependencies };
  }

  it("should format production dependencies with full license text", () => {
    writeInstalledPackage(
      "permissive-lib",
      { version: "1.2.3", license: "MIT", dependencies: { "transitive-lib": "^2.0.0" } },
      "MIT License\r\nCopyright Test  \r\n",
    );
    writeInstalledPackage("transitive-lib", { version: "2.0.0", license: "ISC" }, "ISC text");

    const result = collectThirdPartyNotices({
      repoRoot: tmpRoot,
      workspaces: [workspace({ "permissive-lib": "^1.2.0" })],
      workspacePackageNames: new Set(["@tenkacloud/test-app"]),
    });
    const text = buildThirdPartyNotices(result);

    expect(result.entries.map((e) => e.name)).toEqual(["permissive-lib", "transitive-lib"]);
    expect(text).toContain("permissive-lib@1.2.3 - MIT");
    expect(text).toContain("MIT License\nCopyright Test");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("Copyright Test  ");
    expect(text).toContain("transitive-lib@2.0.0 - ISC");
    expect(text).toContain("ISC text");
  });

  it("should note missing license files and flag copyleft licenses", () => {
    writeInstalledPackage("gpl-lib", { version: "1.0.0", license: "GPL-3.0-only" });

    const result = collectThirdPartyNotices({
      repoRoot: tmpRoot,
      workspaces: [workspace({ "gpl-lib": "^1.0.0" })],
      workspacePackageNames: new Set(["@tenkacloud/test-app"]),
    });
    const text = buildThirdPartyNotices(result);

    expect(result.copyleftEntries.map((e) => e.name)).toEqual(["gpl-lib"]);
    expect(text).toContain("gpl-lib@1.0.0 - GPL-3.0-only");
    expect(text).toContain("WARNING: copyleft/non-permissive license detected");
    expect(text).toContain("NOTE: package did not ship a LICENSE / LICENCE / COPYING file.");
  });

  it("should not flag dual licenses that offer a permissive option", () => {
    // case@1.6.3 / dompurify@3.4.4 style: `A OR B` where one side is permissive — the
    // licensee elects the permissive license, so no copyleft obligation applies.
    writeInstalledPackage("dual-mit-gpl", {
      version: "1.6.3",
      license: "(MIT OR GPL-3.0-or-later)",
    });
    writeInstalledPackage("dual-mpl-apache", {
      version: "3.4.4",
      license: "(MPL-2.0 OR Apache-2.0)",
    });
    writeInstalledPackage("pure-gpl", { version: "2.0.0", license: "GPL-3.0-only" });

    const result = collectThirdPartyNotices({
      repoRoot: tmpRoot,
      workspaces: [
        workspace({
          "dual-mit-gpl": "^1.6.0",
          "dual-mpl-apache": "^3.4.0",
          "pure-gpl": "^2.0.0",
        }),
      ],
      workspacePackageNames: new Set(["@tenkacloud/test-app"]),
    });

    // Only the single-license copyleft package is flagged; both dual-licensed ones are clear.
    expect(result.copyleftEntries.map((e) => e.name)).toEqual(["pure-gpl"]);
  });

  it("should traverse through workspace dependencies without adding first-party packages", () => {
    writeInstalledPackage("@tenkacloud/internal", {
      version: "0.0.0",
      license: "Apache-2.0",
      dependencies: { "external-lib": "^3.0.0" },
    });
    writeInstalledPackage(
      "external-lib",
      { version: "3.0.0", license: "BSD-3-Clause" },
      "BSD text",
    );

    const result = collectThirdPartyNotices({
      repoRoot: tmpRoot,
      workspaces: [workspace({ "@tenkacloud/internal": "workspace:*" })],
      workspacePackageNames: new Set(["@tenkacloud/test-app", "@tenkacloud/internal"]),
    });

    expect(result.entries.map((e) => e.name)).toEqual(["external-lib"]);
  });

  it("should not warn when an optional dependency is absent", () => {
    writeInstalledPackage("optional-parent", {
      version: "1.0.0",
      license: "MIT",
      optionalDependencies: { "linux-only-binary": "^1.0.0" },
    });

    const result = collectThirdPartyNotices({
      repoRoot: tmpRoot,
      workspaces: [workspace({ "optional-parent": "^1.0.0" })],
      workspacePackageNames: new Set(["@tenkacloud/test-app"]),
    });

    expect(result.entries.map((e) => e.name)).toEqual(["optional-parent"]);
    expect(result.warnings).toEqual([]);
  });
});
