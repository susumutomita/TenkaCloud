import { Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

/** Shared Node.js runtime version for all Lambda functions in this project. */
export const LAMBDA_NODEJS_RUNTIME = Runtime.NODEJS_22_X;

/** esbuild `target` aligned with `LAMBDA_NODEJS_RUNTIME`. */
export const LAMBDA_NODEJS_BUNDLING_TARGET = "node22" as const;

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
