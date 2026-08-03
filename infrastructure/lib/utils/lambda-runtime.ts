import { Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

/** Shared Node.js runtime version for all Lambda functions in this project. */
export const LAMBDA_NODEJS_RUNTIME = Runtime.NODEJS_22_X;

/** esbuild `target` aligned with `LAMBDA_NODEJS_RUNTIME`. */
export const LAMBDA_NODEJS_BUNDLING_TARGET = "node22" as const;

/**
 * Issue #2864: Lambda runtime bundle から除外する module パターン (esbuild `--external`)。
 * `defineNodejsFunction` と runtime bundle guard (`runtime-bundle-inspection.ts`) の両方が
 * この 1 定数を参照する (= 実 bundling とテストの設定ドリフトを構造的に防ぐ)。
 *
 * `@aws-sdk/*` は bundle せず、 Node 22 managed runtime 同梱の SDK v3 を実行時解決する。
 * 旧構成 (`externalModules: []` = SDK 全内包) は SDK の patch 更新だけで bundle が +1.5MB 膨らみ
 * (#2864、 nested-clients 再編で認証 provider 連鎖が丸ごと混入)、 過去には bundle 肥大が本番
 * `Runtime.OutOfMemory` を起こした (#2655)。 依存を Lambda に内包しない方向へ設計を倒す。
 *
 * 根拠 (`public.ecr.aws/lambda/nodejs:22` arm64 image、 SDK 3.1049.0 / Node v22.23.2 時点で実測):
 *   - `/var/runtime/node_modules/@aws-sdk` に 543 package が同梱され、 全 handler (workspace
 *     package 経由の transitive import 含む、 esbuild metafile で列挙) が import する 18 package
 *     (client-* 15 種 / lib-dynamodb / s3-request-presigner / credential-provider-node) と
 *     lib-dynamodb が内部依存する util-dynamodb を全て含む。 runtime bootstrap が `NODE_PATH` に
 *     `/var/runtime/node_modules` を含めるため、 CJS bundle の require はそのまま解決する
 *     (コンテナ内で resolve 成功を実測)。
 *   - `@smithy/*` は **外してはならない**: runtime 側では `@aws-sdk/node_modules/@smithy` に
 *     nest されており `/var/task` からは解決できない (同コンテナで `require("@smithy/signature-v4")`
 *     が MODULE_NOT_FOUND になることを実測)。 `gcp-aws-subject-token.ts` の SigV4 署名が
 *     @smithy を直接 import するため bundle に残す。 CDK default
 *     (`sdkV3ExcludeSmithyPackages` flag ON で `["@aws-sdk/*", "@smithy/*"]`) に任せず
 *     明示リストで override するのはこのため。
 *
 * trade-off: 実行される SDK version が runtime 依存になり、 型検査した version と実行 version が
 * ずれ得る (AWS が runtime 側を随時更新する)。 一方で SDK 更新のたびに bundle 肥大 → OOM /
 * CI 上限超過を再発させる従来構成のコストの方が大きい、 が #2864 の判断。 将来 runtime 非同梱の
 * SDK package や runtime より新しい API が必要になった場合は、 この定数を関数単位で override
 * する prop を足すのではなく、 まず runtime image で同梱状況を実測してから設計を再判断する。
 */
export const LAMBDA_EXTERNAL_MODULES: readonly string[] = ["@aws-sdk/*"];

/**
 * Issue #866: Lambda bundle に `.js.map` を含めるかの env-aware フラグ。
 * production では source map を含めないことで、 万一 Lambda artifact が漏れたときに
 * .ts source code (= 内部 logic / IAM / 構造) が復元できるリスクを下げる。
 *
 * `dev` / `staging` では debug 経路 (= CloudWatch Logs の stack trace を読む) を維持するため
 * source map 有効。 環境変数 `CDK_PARAM_ENVIRONMENT` で判定する。
 */
export const LAMBDA_SOURCE_MAP_ENABLED =
  (process.env.CDK_PARAM_ENVIRONMENT ?? "").toLowerCase() !== "production";

/**
 * CloudWatch Logs の保持日数。 全 Lambda の LogGroup に適用する単一の source of truth。
 *
 * 既定では Lambda の LogGroup に retention を一切設定しておらず "Never expire" (= 無限保持)
 * になっていてコスト leak の原因になっていた。 これを既定 1 日に倒し、 `CDK_PARAM_LOG_RETENTION_DAYS`
 * で運用環境ごとに上書きできるようにする (cost-zero 原則)。
 *
 * 値は `${VAR:-default}` placeholder 展開後に文字列で来ることがあるため、 `parseInt` で正規化し、
 * NaN / 非正値は既定 (1 日) に倒す (= fail safe な default)。 ただし「DynamoDB capacity と違い、
 * サポート外の retention 値はそのまま使うと CFn deploy が失敗する」ため、 enum 変換 (resolveLogRetention)
 * 側はサポート外値を **明示エラーで弾く** (fail loudly、 repo 規約)。
 */
export const LAMBDA_LOG_RETENTION_DAYS: number = ((): number => {
  const parsed = Number.parseInt(process.env.CDK_PARAM_LOG_RETENTION_DAYS ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 1 : parsed;
})();

/**
 * CloudWatch Logs がサポートする retention 日数 → `RetentionDays` enum の対応表。
 *
 * AWS の `PutRetentionPolicy` は離散値しか受け付けない (例: 2 日や 10 日は不可)。 対応表に無い値を
 * `retentionInDays` に設定すると CFn deploy が `InvalidParameterException` で失敗するため、
 * `resolveLogRetention` がサポート外値を明示エラーで弾く (fail loudly)。
 */
const RETENTION_DAYS_BY_VALUE: Readonly<Record<number, RetentionDays>> = {
  1: RetentionDays.ONE_DAY,
  3: RetentionDays.THREE_DAYS,
  5: RetentionDays.FIVE_DAYS,
  7: RetentionDays.ONE_WEEK,
  14: RetentionDays.TWO_WEEKS,
  30: RetentionDays.ONE_MONTH,
  60: RetentionDays.TWO_MONTHS,
  90: RetentionDays.THREE_MONTHS,
  120: RetentionDays.FOUR_MONTHS,
  150: RetentionDays.FIVE_MONTHS,
  180: RetentionDays.SIX_MONTHS,
  365: RetentionDays.ONE_YEAR,
  400: RetentionDays.THIRTEEN_MONTHS,
  545: RetentionDays.EIGHTEEN_MONTHS,
  731: RetentionDays.TWO_YEARS,
  1827: RetentionDays.FIVE_YEARS,
  3653: RetentionDays.TEN_YEARS,
};

/**
 * 整数日数を CloudWatch Logs の `RetentionDays` enum に変換する。
 * サポート外の値は例外を投げる (= silent fallback を作らない、 repo 規約)。
 */
export function resolveLogRetention(days: number): RetentionDays {
  const retention = RETENTION_DAYS_BY_VALUE[days];
  if (retention === undefined) {
    const supported = Object.keys(RETENTION_DAYS_BY_VALUE).join(", ");
    throw new Error(
      `Unsupported CloudWatch Logs retention: ${days} days. CDK_PARAM_LOG_RETENTION_DAYS must be one of: ${supported}.`,
    );
  }
  return retention;
}

/** 全 Lambda の LogGroup に適用する `RetentionDays` enum 値 (`LAMBDA_LOG_RETENTION_DAYS` 由来)。 */
export const LAMBDA_LOG_RETENTION: RetentionDays = resolveLogRetention(LAMBDA_LOG_RETENTION_DAYS);
