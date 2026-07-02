import type { Duration } from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import {
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
  /** Lambda env。呼び出し元の現行値をそのまま渡す (NODE_OPTIONS の有無も呼び出し元が決める)。 */
  readonly environment: Record<string, string>;
  readonly timeout: Duration;
  readonly memorySize: number;
  /** esbuild `define` (例: #1308 の 4KB env 上限回避の literal 置換)。未指定なら define なし。 */
  readonly bundlingDefine?: Record<string, string>;
}

export function defineNodejsFunction(
  scope: Construct,
  props: DefineNodejsFunctionProps,
): NodejsFunction {
  return new NodejsFunction(scope, "Function", {
    logGroup: new LogGroup(scope, "FunctionLogGroup", {
      removalPolicy: RemovalPolicy.DESTROY,
    }),
    runtime: LAMBDA_NODEJS_RUNTIME,
    architecture: Architecture.ARM_64,
    entry: props.entry,
    handler: "handler",
    timeout: props.timeout,
    memorySize: props.memorySize,
    environment: props.environment,
    bundling: {
      minify: true,
      target: LAMBDA_NODEJS_BUNDLING_TARGET,
      sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
      externalModules: [],
      ...(props.bundlingDefine ? { define: props.bundlingDefine } : {}),
    },
  });
}
