import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duration } from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";
import type { IRole } from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import {
  LAMBDA_EXTERNAL_MODULES,
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "./lambda-runtime.js";

/**
 * Issue #2208: 全 Lambda construct が手組みしていた `NodejsFunction` の共通スケルトン
 * (LogGroup / runtime / ARM64 / bundling) を 1 実装に集約する factory。
 *
 * **Construct class ではなく factory 関数** であることが本質: 呼び出し元の construct を
 * `scope` にし、子 ID (`Function` / `FunctionLogGroup`) を従来と同一に保つことで
 * CFn logical ID を 1 つも動かさない。 wrapper construct にすると path が 1 段増えて
 * 全 Lambda + LogGroup が REPLACE される。
 *
 * per-function の差分は **すべて明示的に渡す**:
 *   - `environment` は呼び出し元の現行値を verbatim で渡す (`NODE_OPTIONS` の有無を含む)。
 *     factory 側でのデフォルト注入・正規化は CFn UPDATE 差分になるため行わない。
 *   - `timeout` / `memorySize` は必須 (= 暗黙デフォルトによる値ドリフトを禁止)。
 */
export interface DefineNodejsFunctionProps {
  /** handler entry point (`path.resolve(import.meta.dirname, "handlers/.../index.ts")`)。 */
  readonly entry: string;
  /**
   * 物理 Lambda 名の固定 (例: disruption-executor の self-invoke ARN 構築)。
   * 通常は未指定 (= CFn 自動命名)。 log group 名は固定しない (= 明示すると deploy 済み環境で
   * Lambda auto 作成の同名 group と "already exists" 衝突するため、 group は AUTO のまま)。
   */
  readonly functionName?: string;
  /** 事前作成した実行 role を使う場合のみ指定 (例: self-invoke の循環参照回避)。未指定なら auto。 */
  readonly role?: IRole;
  /** Lambda env。呼び出し元の現行値をそのまま渡す (NODE_OPTIONS の有無も呼び出し元が決める)。 */
  readonly environment: Record<string, string>;
  readonly timeout: Duration;
  readonly memorySize: number;
  /** Optional per-function concurrency cap. Omitted for existing functions to preserve templates. */
  readonly reservedConcurrentExecutions?: number;
  /** esbuild `define` (例: #1308 の 4KB env 上限回避の literal 置換)。未指定なら define なし。 */
  readonly bundlingDefine?: Record<string, string>;
  /**
   * bundle に `catalog-data/<name>.json` として同梱する JSON blob (#2891)。
   * runtime は `readCatalogBlob(name)` で読む。
   *
   * `bundlingDefine` は esbuild の argv に載るため、 Linux の 1 引数上限 128 KiB を
   * 超える値を積むと CI だけが `spawnSync bun E2BIG` で死ぬ (macOS にこの上限は無く、
   * ローカル synth では再現しない)。 カタログと共に育つ blob はこちらに置く。
   */
  readonly bundledData?: Record<string, string>;
}

/**
 * 1 つの define 値に許す上限。 Linux の MAX_ARG_STRLEN (128 KiB) の手前で、 名前入りで
 * synth を落とす — E2BIG は どの define が犯人かを言わないまま CI を殺すため。
 */
export const MAX_DEFINE_VALUE_BYTES = 100 * 1024;

export function defineNodejsFunction(
  scope: Construct,
  props: DefineNodejsFunctionProps,
): NodejsFunction {
  for (const [key, value] of Object.entries(props.bundlingDefine ?? {})) {
    if (Buffer.byteLength(value, "utf8") > MAX_DEFINE_VALUE_BYTES) {
      throw new Error(
        `bundlingDefine["${key}"] is ${Buffer.byteLength(value, "utf8")} bytes — esbuild receives it as one argv entry, and Linux caps a single argument at 128 KiB (spawnSync E2BIG, #2891). Move it to bundledData and read it with readCatalogBlob().`,
      );
    }
  }
  const bundledDataEntries = Object.entries(props.bundledData ?? {});
  let bundledDataDir: string | undefined;
  if (bundledDataEntries.length > 0) {
    // 一時 dir に書き、 afterBundling で bundle へ copy する。 asset hash は bundle
    // "出力" の内容から計算されるので、 一時 dir のパスが毎回違っても hash は安定する。
    bundledDataDir = mkdtempSync(join(tmpdir(), "tc-bundled-data-"));
    for (const [name, json] of bundledDataEntries) {
      writeFileSync(join(bundledDataDir, `${name}.json`), json, "utf8");
    }
  }
  return new NodejsFunction(scope, "Function", {
    ...(props.functionName ? { functionName: props.functionName } : {}),
    ...(props.role ? { role: props.role } : {}),
    logGroup: new LogGroup(scope, "FunctionLogGroup", {
      removalPolicy: RemovalPolicy.DESTROY,
    }),
    runtime: LAMBDA_NODEJS_RUNTIME,
    architecture: Architecture.ARM_64,
    entry: props.entry,
    handler: "handler",
    timeout: props.timeout,
    memorySize: props.memorySize,
    ...(props.reservedConcurrentExecutions !== undefined
      ? { reservedConcurrentExecutions: props.reservedConcurrentExecutions }
      : {}),
    environment: props.environment,
    bundling: {
      minify: true,
      target: LAMBDA_NODEJS_BUNDLING_TARGET,
      sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
      // Issue #2864: `@aws-sdk/*` は runtime 同梱 SDK を使い bundle しない (旧: `[]` = 全内包)。
      // `@smithy/*` は runtime から解決できないため bundle に残す。 根拠と実測は
      // `LAMBDA_EXTERNAL_MODULES` の doc comment を参照。
      externalModules: [...LAMBDA_EXTERNAL_MODULES],
      ...(props.bundlingDefine ? { define: props.bundlingDefine } : {}),
      ...(bundledDataDir
        ? {
            commandHooks: {
              beforeBundling: () => [],
              beforeInstall: () => [],
              afterBundling: (_inputDir: string, outputDir: string) => [
                `mkdir -p "${outputDir}/catalog-data"`,
                ...bundledDataEntries.map(
                  ([name]) =>
                    `cp "${join(bundledDataDir, `${name}.json`)}" "${outputDir}/catalog-data/"`,
                ),
              ],
            },
          }
        : {}),
    },
  });
}
