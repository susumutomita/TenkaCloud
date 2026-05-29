import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCreate, runValidate } from "../../../scripts/tenkacloud-problem";

/**
 * [Issue #1267 / ADR-023] optional `runtime` metadata の Phase 1 schema + CLI 検証。
 *
 * 観点:
 *   1. legacy (= `cfnTemplate` のみ) 問題は引き続き valid (= 後方互換)
 *   2. 明示宣言 `{aws, cloudformation, template.yaml}` は valid
 *   3. `runtime.entry` と `cfnTemplate` が食い違うと reject
 *   4. AWS / CloudFormation 以外は reject。 ADR-026/027 の roadmap provider (reserved) は
 *      tracker #1408 を案内し、 それ以外 (unknown) は typo として案内する (= メッセージを分岐)
 *   5. `runCreate` (= `/create-problem` scaffold) が runtime block を含む metadata を吐く
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore — partial cleanup でも他 test 影響なし
    }
  }
});

/**
 * Test helper: 既存 sample scaffold を base に metadata を改造して fixture 問題を 1 つ作る。
 * runCreate の path を再利用しないのは、 runtime block を後付けで override したいから。
 */
function writeFixtureProblem(opts: {
  uniqueId: string;
  category: "battles" | "challenges";
  mutate: (meta: Record<string, unknown>) => void;
}): string {
  const { uniqueId, category, mutate } = opts;
  const dir = join(REPO_ROOT, "problems", category, uniqueId);
  createdPaths.push(dir);
  mkdirSync(dir, { recursive: true });

  // Minimal valid metadata + template; we only care about runtime/cfnTemplate consistency here.
  const meta: Record<string, unknown> = {
    $schema: "../../SCHEMA.json",
    id: uniqueId,
    name: "fixture",
    category: category === "battles" ? "Battle" : "Challenge",
    status: "draft",
    difficulty: 1,
    estimatedDuration: "10 分",
    shortDescription: "runtime metadata fixture",
    description: "runtime metadata fixture",
    tags: ["fixture"],
    exposedPorts: [{ port: 1, name: "noop" }],
    learningGoals: ["fixture"],
    cfnTemplate: "template.yaml",
  };
  mutate(meta);
  writeFileSync(join(dir, "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  writeFileSync(
    join(dir, "template.yaml"),
    "AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  NamePrefix:\n    Type: String\nResources:\n  Noop:\n    Type: AWS::CloudFormation::WaitConditionHandle\n",
    "utf8",
  );
  return dir;
}

describe("ADR-023 / Issue #1267: provider-specific runtime metadata", () => {
  it("should keep legacy problems (cfnTemplate only) valid", () => {
    const uniqueId = `test-runtime-legacy-${Date.now().toString(36)}`;
    writeFixtureProblem({
      uniqueId,
      category: "challenges",
      mutate: () => {
        // no runtime block — strictly legacy shape
      },
    });
    const r = runValidate(uniqueId);
    if (!r.ok) {
      throw new Error(`expected legacy fixture to validate, got: ${r.errors.join("; ")}`);
    }
    expect(r.ok).toBe(true);
  });

  it("should accept explicit aws/cloudformation runtime declaration", () => {
    const uniqueId = `test-runtime-aws-${Date.now().toString(36)}`;
    writeFixtureProblem({
      uniqueId,
      category: "challenges",
      mutate: (meta) => {
        meta.runtime = {
          provider: "aws",
          engine: "cloudformation",
          entry: "template.yaml",
        };
      },
    });
    const r = runValidate(uniqueId);
    if (!r.ok) {
      throw new Error(`expected explicit-runtime fixture to validate, got: ${r.errors.join("; ")}`);
    }
    expect(r.ok).toBe(true);
  });

  it("should reject when runtime.entry and cfnTemplate disagree", () => {
    const uniqueId = `test-runtime-inconsistent-${Date.now().toString(36)}`;
    writeFixtureProblem({
      uniqueId,
      category: "challenges",
      mutate: (meta) => {
        meta.cfnTemplate = "template.yaml";
        meta.runtime = {
          provider: "aws",
          engine: "cloudformation",
          entry: "other-template.yaml",
        };
      },
    });
    const r = runValidate(uniqueId);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("must match"))).toBe(true);
  });

  it("should reject a planned (reserved) provider/engine and point at the roadmap tracker", () => {
    // azure/bicep is on the ADR-027 roadmap: rejected (no adapter yet) but the
    // message must say "planned" and cite the tracker, not treat it as a typo.
    const uniqueId = `test-runtime-azure-${Date.now().toString(36)}`;
    writeFixtureProblem({
      uniqueId,
      category: "challenges",
      mutate: (meta) => {
        meta.runtime = {
          provider: "azure",
          engine: "bicep",
          entry: "template.yaml",
        };
      },
    });
    const r = runValidate(uniqueId);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) => e.includes("azure/bicep") && e.includes("planned") && e.includes("#1408"),
      ),
    ).toBe(true);
    expect(r.errors.some((e) => e.includes("azure/bicep") && e.includes("typo"))).toBe(false);
  });

  it("should reject an unrecognized provider/engine as a likely typo", () => {
    const uniqueId = `test-runtime-typo-${Date.now().toString(36)}`;
    writeFixtureProblem({
      uniqueId,
      category: "challenges",
      mutate: (meta) => {
        meta.runtime = {
          provider: "kuberntes", // intentional misspelling of "kubernetes"
          engine: "helm",
          entry: "template.yaml",
        };
      },
    });
    const r = runValidate(uniqueId);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("kuberntes/helm") && e.includes("typo"))).toBe(true);
  });

  it("should scaffold new problems with an explicit aws/cloudformation runtime block", () => {
    const uniqueId = `test-runtime-scaffold-${Date.now().toString(36)}`;
    const created = runCreate({ problemId: uniqueId, kind: "flag" });
    createdPaths.push(created.outputDir);

    expect(existsSync(join(created.outputDir, "metadata.json"))).toBe(true);
    const metadata = JSON.parse(readFileSync(join(created.outputDir, "metadata.json"), "utf8"));
    expect(metadata.runtime).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });

    // Scaffold should validate end-to-end through the same CLI path.
    const r = runValidate(uniqueId);
    if (!r.ok) {
      throw new Error(`scaffold should validate, got: ${r.errors.join("; ")}`);
    }
    expect(r.ok).toBe(true);
  });
});
