import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBreakingChanges, type Spec } from "./generate-machine-api";

/**
 * Issue #2950: 破壊的変更 gate。
 *
 * 「version を上げずに壊す」ことだけを禁止する。gate が本当に働くことを、実際に壊した spec を
 * 食わせて確認する — 何を渡しても空配列を返す検出器なら、下の positive test だけでは気付けない。
 */

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(here, "..", "src", "content", "machine-api-baseline.json");

// 破壊的変更を作るために書き換えるので、fixture 側は mutable な形で持つ。`Spec` は readonly
// なので、mutable な object はそのまま代入できる。
interface MutableOperation {
  [key: string]: unknown;
}

interface MutableSpec {
  info: { version: string; [key: string]: unknown };
  paths: Record<string, Record<string, MutableOperation>>;
  [key: string]: unknown;
}

function asSpec(spec: MutableSpec): Spec {
  return spec;
}

function baseline(): MutableSpec {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as MutableSpec;
}

function clone(spec: MutableSpec): MutableSpec {
  return JSON.parse(JSON.stringify(spec)) as MutableSpec;
}

describe("findBreakingChanges", () => {
  it("should report nothing when the spec is unchanged", () => {
    expect(findBreakingChanges(asSpec(baseline()), asSpec(baseline()))).toEqual([]);
  });

  it("should report a removed operation", () => {
    const candidate = clone(baseline());
    delete candidate.paths["/deployments"];
    expect(findBreakingChanges(asSpec(baseline()), asSpec(candidate))).toContain(
      "operation removed: GET /deployments",
    );
  });

  it("should report a renamed operationId", () => {
    const candidate = clone(baseline());
    const operation = candidate.paths["/deployments"]?.get;
    if (operation) operation.operationId = "listDeploymentsRenamed";
    expect(findBreakingChanges(asSpec(baseline()), asSpec(candidate)).join("\n")).toContain(
      "operationId renamed",
    );
  });

  it("should report a changed required scope", () => {
    const candidate = clone(baseline());
    const operation = candidate.paths["/deployments"]?.get;
    if (operation) operation.security = [{ TenkaCloudMachineOAuth: ["tenkacloud/ops.deploy"] }];
    expect(findBreakingChanges(asSpec(baseline()), asSpec(candidate)).join("\n")).toContain(
      "required scope changed",
    );
  });

  it("should report a newly required request field", () => {
    const candidate = clone(baseline());
    const operation = candidate.paths["/problems/{problemId}/deploy"]?.post as
      | {
          requestBody?: { content: Record<string, { schema?: { required?: string[] } }> };
        }
      | undefined;
    const schema = operation?.requestBody?.content["application/json"]?.schema;
    if (schema) schema.required = [...(schema.required ?? []), "newlyRequired"];
    expect(findBreakingChanges(asSpec(baseline()), asSpec(candidate)).join("\n")).toContain(
      "required request field added",
    );
  });

  it("should not report an added operation as breaking", () => {
    const candidate = clone(baseline());
    candidate.paths["/brand-new"] = {
      get: {
        operationId: "getBrandNew",
        security: [{ TenkaCloudMachineOAuth: ["tenkacloud/ops.read"] }],
      },
    };
    expect(findBreakingChanges(asSpec(baseline()), asSpec(candidate))).toEqual([]);
  });
});
