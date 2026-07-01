/**
 * [Problem SDK / Issue #2108] Tests for the deterministic pack-validation report
 * and the `pack-report` CLI the reusable external Pack CI workflow runs.
 *
 * These cover the issue's required behaviours for the report layer:
 *   - a minimal external pack passes through (result "passed");
 *   - an invalid pack fails (result "failed") with public namespaced codes;
 *   - the report + serialization are byte-deterministic for equal content;
 *   - the CLI writes the report file, emits GitHub outputs, and returns the
 *     contracted exit codes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPackReport, computeContentDigest, serializePackReport } from "../src/report.js";
import { runPackReportCli } from "../src/report-cli.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTemp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-report-"));
  tempDirs.push(root);
  return root;
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: "com.example.pack",
  version: "1.2.3",
  core: "^1.0.0",
  title: "Pack",
  description: "A pack.",
  license: "Apache-2.0",
  problemsRoot: "problems",
  requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
};

/** Write a minimal, validator-passing single-problem pack into `root`. */
function writeMinimalPack(root: string, manifestOverrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(root, "tenkacloud-pack.json"),
    JSON.stringify({ ...VALID_MANIFEST, ...manifestOverrides }),
  );
  const problemDir = path.join(root, "problems", "challenge", "hello-world");
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify({
      id: "hello-world",
      title: "Hello World",
      category: "challenge",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
      cfnTemplate: "template.yaml",
    }),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
}

describe("buildPackReport: passing pack", () => {
  it("should report a minimal external pack as passed with the manifest id and version", () => {
    const root = mkTemp();
    writeMinimalPack(root);

    const report = buildPackReport(root);

    expect(report.result).toBe("passed");
    expect(report.packId).toBe("com.example.pack");
    expect(report.packVersion).toBe("1.2.3");
    expect(report.problemIds).toEqual(["hello-world"]);
    expect(report.diagnostics).toEqual([]);
    expect(report.ranLocalTests).toBe(true);
    expect(report.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should record ranLocalTests false when local tests are disabled", () => {
    const root = mkTemp();
    writeMinimalPack(root);

    const report = buildPackReport(root, { runLocalTests: false });

    expect(report.ranLocalTests).toBe(false);
    // Disabling local tests does not weaken validation — it still passes.
    expect(report.result).toBe("passed");
  });
});

describe("buildPackReport: failing pack", () => {
  it("should fail before any harness execution when the manifest is invalid", () => {
    const root = mkTemp();
    // Unknown top-level field — the strict manifest schema rejects it.
    writeMinimalPack(root, { unexpectedField: true });

    const report = buildPackReport(root);

    expect(report.result).toBe("failed");
    expect(report.diagnostics.length).toBeGreaterThan(0);
    // Public namespaced code from #2106 — never the internal "MANIFEST_INVALID".
    expect(report.diagnostics.map((d) => d.code)).toContain("PACK_MANIFEST_INVALID");
  });

  it("should fail with PACK_DIR_MISSING for a non-existent pack directory", () => {
    const root = mkTemp();
    const report = buildPackReport(path.join(root, "does-not-exist"));

    expect(report.result).toBe("failed");
    expect(report.diagnostics.map((d) => d.code)).toContain("PACK_DIR_MISSING");
    expect(report.packId).toBe("");
    expect(report.packVersion).toBe("");
  });

  it("should map every diagnostic onto a public namespaced code", () => {
    const root = mkTemp();
    writeMinimalPack(root, { problemsRoot: "missing-root" });

    const report = buildPackReport(root);

    expect(report.result).toBe("failed");
    for (const diagnostic of report.diagnostics) {
      expect(diagnostic.code).toMatch(/^(PACK|PROBLEM|RUNTIME|SCORING)_/);
    }
  });
});

describe("buildPackReport: determinism", () => {
  it("should produce a byte-identical serialized report for identical content", () => {
    const a = mkTemp();
    const b = mkTemp();
    writeMinimalPack(a);
    writeMinimalPack(b);

    const reportA = serializePackReport(buildPackReport(a));
    const reportB = serializePackReport(buildPackReport(b));

    // Reports differ only structurally if content differs; identical bytes here.
    expect(reportA).toBe(reportB);
  });

  it("should compute an identical content digest for identical pack content", () => {
    const a = mkTemp();
    const b = mkTemp();
    writeMinimalPack(a);
    writeMinimalPack(b);

    expect(computeContentDigest(a)).toBe(computeContentDigest(b));
  });

  it("should change the content digest when a tracked file changes", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const before = computeContentDigest(root);
    fs.writeFileSync(
      path.join(root, "problems", "challenge", "hello-world", "template.yaml"),
      "x\n",
    );

    expect(computeContentDigest(root)).not.toBe(before);
  });

  it("should ignore dot-files and node_modules in the digest", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const before = computeContentDigest(root);
    fs.writeFileSync(path.join(root, ".secret"), "ignored\n");
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "x", "y.js"), "ignored\n");

    expect(computeContentDigest(root)).toBe(before);
  });

  it("should return a stable digest for a missing directory without throwing", () => {
    const root = mkTemp();
    const digest = computeContentDigest(path.join(root, "nope"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runPackReportCli", () => {
  it("should return exit 0 and write a report file for a passing pack", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const reportPath = path.join(mkTemp(), "report.json");
    const lines: string[] = [];

    const code = runPackReportCli([root, "--out", reportPath], {}, (l) => lines.push(l));

    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    expect(written.result).toBe("passed");
    expect(written.packId).toBe("com.example.pack");
    expect(lines.join("\n")).toContain("passed");
  });

  it("should return exit 1 for an invalid pack and still produce a report", () => {
    const root = mkTemp();
    writeMinimalPack(root, { unexpectedField: true });
    const reportPath = path.join(mkTemp(), "report.json");

    const code = runPackReportCli([root, "--out", reportPath], {}, () => {});

    expect(code).toBe(1);
    const written = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    expect(written.result).toBe("failed");
  });

  it("should append stable GitHub outputs when GITHUB_OUTPUT is set", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const outFile = path.join(mkTemp(), "github_output");
    fs.writeFileSync(outFile, "");

    runPackReportCli([root], { GITHUB_OUTPUT: outFile }, () => {});

    const outputs = fs.readFileSync(outFile, "utf-8");
    expect(outputs).toContain("result=passed");
    expect(outputs).toContain("pack-id=com.example.pack");
    expect(outputs).toContain("pack-version=1.2.3");
    expect(outputs).toMatch(/content-digest=[0-9a-f]{64}/);
  });

  it("should return exit 2 on missing pack directory argument", () => {
    const lines: string[] = [];
    const code = runPackReportCli(["--out", "x.json"], {}, (l) => lines.push(l));
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Usage");
  });

  it("should return exit 2 on a malformed --out flag", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const code = runPackReportCli([root, "--out"], {}, () => {});
    expect(code).toBe(2);
  });

  it("should honor --no-local-tests by recording it in the written report", () => {
    const root = mkTemp();
    writeMinimalPack(root);
    const reportPath = path.join(mkTemp(), "report.json");

    runPackReportCli([root, "--no-local-tests", "--out", reportPath], {}, () => {});

    const written = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    expect(written.ranLocalTests).toBe(false);
  });
});
