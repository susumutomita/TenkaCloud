import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCrossRefs, checkRuntimeSupport } from "../../../scripts/validate-problems";

/**
 * ADR-026 / ADR-027: validate-problems.ts の multi-cloud runtime 対応。
 *
 * - CFn Outputs 構文を前提にした cross-ref (scoring.flagOutputKey / endpoints[].key) は
 *   executable な aws/cloudformation のときだけ走る。 予約済み (sakura/azure/gcp) は
 *   出力 binding 機構が provider 固有 + まだ deploy 不可なので skip し、 spurious error にしない。
 * - executable でも予約済みでもない provider/engine は typo guard で reject。
 * - runtime object が壊れている (provider/engine/entry が string でない) なら reject。
 */

describe("checkRuntimeSupport", () => {
  it("should accept the executable aws/cloudformation runtime", () => {
    expect(
      checkRuntimeSupport({ provider: "aws", engine: "cloudformation", entry: "template.yaml" }),
    ).toEqual([]);
  });

  it.each([
    { provider: "sakura", engine: "apprun" },
    { provider: "azure", engine: "bicep" },
    { provider: "gcp", engine: "infra-manager" },
  ])("should accept the reserved runtime $provider/$engine", (rt) => {
    expect(checkRuntimeSupport({ ...rt, entry: "x" })).toEqual([]);
  });

  it("should reject an unknown provider/engine as a likely typo", () => {
    const errs = checkRuntimeSupport({ provider: "aws", engine: "cfn", entry: "x" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("typo");
    expect(errs[0]).toContain("sakura/apprun"); // 予約済み一覧を案内する
  });
});

describe("checkCrossRefs runtime awareness", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tc-validate-runtime-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeProblem = (
    sub: string,
    meta: Record<string, unknown>,
    template: { name: string; body: string },
  ): { metaPath: string; meta: Record<string, unknown> } => {
    const pdir = join(dir, sub);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, template.name), template.body);
    const metaPath = join(pdir, "metadata.json");
    writeFileSync(metaPath, JSON.stringify(meta));
    return { metaPath, meta };
  };

  it("should skip CFn output cross-refs for a reserved azure/bicep runtime", () => {
    // scoring.flagOutputKey / endpoints[].key は CFn Outputs 構文を持たない bicep file を指すが、
    // executable でないので CFn check は走らず spurious error にならない。
    const { metaPath, meta } = writeProblem(
      "azure-problem",
      {
        runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
        // points は SCHEMA 必須 field。 #1777 semantic check (flag) も正値を要求する。
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
        endpoints: [{ slot: "web", default: { from: "cfn-output", key: "ServiceUrl" } }],
      },
      { name: "main.bicep", body: "// bicep template, no CFn Outputs here\n" },
    );
    expect(checkCrossRefs(metaPath, meta)).toEqual([]);
  });

  it("should still run CFn output cross-refs for the executable aws/cloudformation runtime", () => {
    const { metaPath, meta } = writeProblem(
      "aws-problem",
      {
        runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
      },
      { name: "template.yaml", body: "Outputs:\n  SomethingElse:\n    Value: x\n" },
    );
    const errors = checkCrossRefs(metaPath, meta);
    expect(errors.some((e) => e.includes("FlagValue"))).toBe(true);
  });

  it("should reject an unknown runtime via checkCrossRefs (typo guard)", () => {
    const { metaPath, meta } = writeProblem(
      "typo-problem",
      { runtime: { provider: "aws", engine: "cfn", entry: "template.yaml" } },
      { name: "template.yaml", body: "Outputs: {}\n" },
    );
    const errors = checkCrossRefs(metaPath, meta);
    expect(errors.some((e) => e.includes("typo"))).toBe(true);
  });

  it("should reject a malformed runtime object", () => {
    const { metaPath, meta } = writeProblem(
      "malformed-problem",
      { runtime: { provider: 123, engine: "bicep", entry: "main.bicep" } },
      { name: "main.bicep", body: "x\n" },
    );
    expect(checkCrossRefs(metaPath, meta)).toEqual([
      "runtime object が不正です (provider / engine / entry はすべて string 必須)",
    ]);
  });

  it("should report when the runtime entry file is missing", () => {
    const pdir = join(dir, "missing-entry");
    mkdirSync(pdir, { recursive: true });
    const metaPath = join(pdir, "metadata.json");
    const meta = { runtime: { provider: "gcp", engine: "infra-manager", entry: "main.tf" } };
    writeFileSync(metaPath, JSON.stringify(meta));
    const errors = checkCrossRefs(metaPath, meta);
    expect(errors).toEqual(['runtime entry file "main.tf" not found']);
  });

  it("should default to template.yaml for a legacy problem with no runtime declared", () => {
    const { metaPath, meta } = writeProblem(
      "legacy-problem",
      { scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 } },
      { name: "template.yaml", body: "Outputs:\n  FlagValue:\n    Value: x\n" },
    );
    // legacy = aws/cloudformation 既定 → CFn check が走り、 FlagValue は Outputs にあるので OK。
    expect(checkCrossRefs(metaPath, meta)).toEqual([]);
  });
});
