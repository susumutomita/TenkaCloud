import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBreakingChanges, type GeneratorPaths, main, type Spec } from "./generate-machine-api";

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

/**
 * generator 本体。`--check` は prebuild と CI から呼ばれる drift gate なので、通る経路だけでなく
 * **落ちる経路**を確かめる。落ちない gate は無いのと同じで、しかも「毎回 0 を返す gate」は
 * 生成物が古いまま build を通してしまう。
 */
describe("generate-machine-api main", () => {
  let workdir: string;
  const messages: { log: string[]; error: string[] } = { log: [], error: [] };
  const out = {
    log: (m: string) => messages.log.push(m),
    error: (m: string) => messages.error.push(m),
  };

  function pathsIn(dir: string): GeneratorPaths {
    return {
      specPath: join(dir, "spec.json"),
      baselinePath: join(dir, "baseline.json"),
      outputPath: join(dir, "machine-api.generated.ts"),
    };
  }

  function writeSpecs(dir: string, spec: MutableSpec, base: MutableSpec = spec) {
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec), "utf8");
    writeFileSync(join(dir, "baseline.json"), JSON.stringify(base), "utf8");
  }

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "machine-api-gen-"));
    messages.log = [];
    messages.error = [];
  });

  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("should write a module that embeds the spec and exports the operation list", () => {
    writeSpecs(workdir, baseline());
    expect(main([], pathsIn(workdir), out)).toBe(0);
    const written = readFileSync(join(workdir, "machine-api.generated.ts"), "utf8");
    expect(written).toContain("GENERATED FILE — DO NOT EDIT.");
    expect(written).toContain("export const MACHINE_API_SPEC");
    expect(written).toContain("listMachineApiOperations");
    // spec が本文として埋まっていること (= 参照ではなく埋め込み) を 1 つの operationId で見る。
    expect(written).toContain("getDeployments");
    expect(messages.log).toEqual(["wrote src/content/machine-api.generated.ts"]);
  });

  it("should pass --check when the committed module matches", () => {
    writeSpecs(workdir, baseline());
    expect(main([], pathsIn(workdir), out)).toBe(0);
    messages.log = [];
    expect(main(["--check"], pathsIn(workdir), out)).toBe(0);
    expect(messages.log.join(" ")).toContain("上流の spec と一致");
  });

  it("should fail --check when the committed module drifted from the spec", () => {
    writeSpecs(workdir, baseline());
    main([], pathsIn(workdir), out);
    writeFileSync(join(workdir, "machine-api.generated.ts"), "// stale\n", "utf8");
    expect(main(["--check"], pathsIn(workdir), out)).toBe(1);
    expect(messages.error.join(" ")).toContain("一致しません");
  });

  it("should fail --check when the module has never been generated", () => {
    writeSpecs(workdir, baseline());
    expect(main(["--check"], pathsIn(workdir), out)).toBe(1);
    expect(messages.error.join(" ")).toContain("がありません");
  });

  it("should refuse a breaking change that leaves info.version untouched", () => {
    // これが gate の存在理由。version 据え置きのまま operation を消すと build が落ちる。
    const candidate = clone(baseline());
    delete candidate.paths["/deployments"];
    writeSpecs(workdir, candidate, baseline());
    expect(main([], pathsIn(workdir), out)).toBe(1);
    expect(messages.error.join(" ")).toContain("operation removed: GET /deployments");
    // 落ちたときに生成物を書き換えていないこと (= 半端な状態を commit させない)。
    expect(existsSync(join(workdir, "machine-api.generated.ts"))).toBe(false);
  });

  it("should allow the same breaking change once info.version is bumped", () => {
    const candidate = clone(baseline());
    delete candidate.paths["/deployments"];
    candidate.info.version = `${baseline().info.version}-next`;
    writeSpecs(workdir, candidate, baseline());
    expect(main([], pathsIn(workdir), out)).toBe(0);
    expect(messages.error).toEqual([]);
  });
});
