#!/usr/bin/env tsx
/**
 * Issue #2950: portal が描画する machine API spec を **リポジトリの生成物から取り込む**。
 *
 * 上流の正本は `docs/api/machine-api.openapi.json` で、そこ自体が
 * `MACHINE_ROUTE_SCOPES` + handler の zod schema から `scripts/openapi/generate.ts` が生成
 * している (#2949)。portal 側はそれを TypeScript module に写すだけで、内容を編集しない。
 *
 *   tsx scripts/generate-machine-api.ts          生成
 *   tsx scripts/generate-machine-api.ts --check  drift があれば非ゼロ終了 (prebuild / CI)
 *
 * ## 破壊的変更の扱い
 *
 * `src/content/machine-api-baseline.json` は「前回公開した spec」である。新しい spec が
 * baseline に対して破壊的 (operation の削除、必須 scope の変更、required field の追加) な
 * のに `info.version` が据え置きなら **build を落とす**。version を上げるか、破壊的でない
 * 形に直すかを選ばせる。baseline を更新するのは version を上げた PR の仕事になる。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const SPEC_PATH = resolve(REPO_ROOT, "docs/api/machine-api.openapi.json");
const OUTPUT_PATH = resolve(here, "..", "src", "content", "machine-api.generated.ts");
const BASELINE_PATH = resolve(here, "..", "src", "content", "machine-api-baseline.json");

export interface Operation {
  readonly operationId?: unknown;
  readonly security?: unknown;
  readonly requestBody?: {
    readonly content?: Record<string, { readonly schema?: { readonly required?: string[] } }>;
  };
  readonly [key: string]: unknown;
}

export interface Spec {
  readonly info: { readonly version: string; readonly [key: string]: unknown };
  readonly paths: Record<string, Record<string, Operation>>;
  readonly [key: string]: unknown;
}

function readSpec(path: string): Spec {
  return JSON.parse(readFileSync(path, "utf8")) as Spec;
}

function operationKeys(spec: Spec): string[] {
  return Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function operationAt(spec: Spec, key: string): Operation | undefined {
  const [method = "", path = ""] = key.split(" ");
  return spec.paths[path]?.[method.toLowerCase()];
}

function requiredBodyFields(operation: Operation | undefined): string[] {
  const schema = operation?.requestBody?.content?.["application/json"]?.schema;
  return [...(schema?.required ?? [])].sort();
}

/** baseline から candidate への破壊的変更を列挙する。空なら後方互換。 */
export function findBreakingChanges(baseline: Spec, candidate: Spec): string[] {
  const breaking: string[] = [];
  const baselineKeys = operationKeys(baseline);
  const candidateKeys = new Set(operationKeys(candidate));

  for (const key of baselineKeys) {
    if (!candidateKeys.has(key)) {
      breaking.push(`operation removed: ${key}`);
      continue;
    }
    const before = operationAt(baseline, key);
    const after = operationAt(candidate, key);
    if (before?.operationId !== after?.operationId) {
      breaking.push(
        `operationId renamed: ${key} (${String(before?.operationId)} -> ${String(after?.operationId)})`,
      );
    }
    if (JSON.stringify(before?.security) !== JSON.stringify(after?.security)) {
      breaking.push(`required scope changed: ${key}`);
    }
    const addedRequired = requiredBodyFields(after).filter(
      (field) => !requiredBodyFields(before).includes(field),
    );
    if (addedRequired.length > 0) {
      breaking.push(`required request field added: ${key} (${addedRequired.join(", ")})`);
    }
  }
  return breaking;
}

/**
 * 生成テキストを committed Biome formatter に通す。write と `--check` の両方が同じ整形を
 * 経由するので、drift 比較が整形差でぶれず、commit 済みファイルも lint を通る
 * (generate-reference.ts と同じ扱い)。
 */
function formatWithBiome(source: string): string {
  return execFileSync("bunx", ["biome", "format", "--stdin-file-path=machine-api.generated.ts"], {
    cwd: REPO_ROOT,
    input: source,
    encoding: "utf8",
  });
}

function renderModule(spec: Spec): string {
  return formatWithBiome(`// GENERATED FILE — DO NOT EDIT.
// Source: docs/api/machine-api.openapi.json (itself generated from MACHINE_ROUTE_SCOPES
// and the handler zod schemas by scripts/openapi/generate.ts).
// Regenerate with: bun run --filter @TenkaCloud/developer-portal generate:machine-api
//
// The spec is embedded, not fetched at runtime: the portal is a static export and
// must not reach out to GitHub or any other host to render its own reference.

// 上流 spec は OpenAPI の任意フィールド (license / parameters / requestBody ...) を持つ。
// portal が読む必要のあるものだけを名前で型付けし、残りは index signature で受ける。
export interface MachineApiSpec {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string } & {
    readonly [key: string]: unknown;
  };
  readonly servers: readonly unknown[];
  readonly paths: Record<string, Record<string, MachineApiOperation>>;
  readonly components: Record<string, unknown>;
}

export interface MachineApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly "x-tenkacloud-capability": string;
  readonly responses: Record<string, { readonly description: string } & { readonly [key: string]: unknown }>;
  readonly [key: string]: unknown;
}

export const MACHINE_API_SPEC: MachineApiSpec = ${JSON.stringify(spec, null, 2)};

export interface MachineApiOperationRow {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly capability: string;
  readonly scope: string;
}

/** Flat operation list for the static table rendered next to the Scalar reference. */
export function listMachineApiOperations(): MachineApiOperationRow[] {
  return Object.entries(MACHINE_API_SPEC.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      operationId: operation.operationId,
      summary: operation.summary,
      capability: operation["x-tenkacloud-capability"],
      scope: Object.values(operation.security[0] ?? {})[0]?.[0] ?? "",
    })),
  );
}
`);
}

/**
 * 読み書きする 3 つの path。既定は repository の実ファイルで、test は temp dir を渡す。
 * path を引数にしておかないと `main` は「実際の生成物を上書きする」以外の呼び方ができず、
 * version gate と drift 判定という **落ちてほしい経路**を検証できない。
 */
export interface GeneratorPaths {
  readonly specPath: string;
  readonly baselinePath: string;
  readonly outputPath: string;
}

export const DEFAULT_PATHS: GeneratorPaths = {
  specPath: SPEC_PATH,
  baselinePath: BASELINE_PATH,
  outputPath: OUTPUT_PATH,
};

export function main(
  argv: readonly string[],
  paths: GeneratorPaths = DEFAULT_PATHS,
  out: Pick<Console, "log" | "error"> = console,
): number {
  const check = argv.includes("--check");
  const spec = readSpec(paths.specPath);

  const baseline = readSpec(paths.baselinePath);
  const breaking = findBreakingChanges(baseline, spec);
  if (breaking.length > 0 && baseline.info.version === spec.info.version) {
    out.error(
      `machine API spec に破壊的変更がありますが info.version が ${spec.info.version} のままです:\n` +
        breaking.map((line) => `  - ${line}`).join("\n") +
        "\ninfo.version を上げ、src/content/machine-api-baseline.json を更新してください。",
    );
    return 1;
  }

  const rendered = renderModule(spec);
  if (check) {
    let current: string;
    try {
      current = readFileSync(paths.outputPath, "utf8");
    } catch {
      out.error("src/content/machine-api.generated.ts がありません。生成してください。");
      return 1;
    }
    if (current !== rendered) {
      out.error(
        "src/content/machine-api.generated.ts が docs/api/machine-api.openapi.json と一致しません。" +
          " `bun run generate:machine-api` を実行して commit してください。",
      );
      return 1;
    }
    out.log("OK: machine API reference は上流の spec と一致しています。");
    return 0;
  }

  writeFileSync(paths.outputPath, rendered, "utf8");
  out.log("wrote src/content/machine-api.generated.ts");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
