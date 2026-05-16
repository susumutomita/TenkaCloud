import { Runtime } from "aws-cdk-lib/aws-lambda";

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
