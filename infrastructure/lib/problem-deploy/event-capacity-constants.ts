/**
 * Issue #2410: イベント中 DynamoDB キャパシティ運用の共有定数。
 *
 * CDK construct (`event-capacity-runbook.ts`) と Lambda handler
 * (`handlers/event-handler/capacity.ts`) の両方が import するため、aws-cdk-lib にも
 * AWS SDK にも依存しない葉モジュールとして分離する (= handler bundle に CDK を引き込まない)。
 */

/**
 * runbook が受け付けるキャパシティの構造的ハード上限 (課金爆死ガード)。
 * 桁打ち間違い (例: 20 のつもりが 2000) は SSM parameter validation の段階で fail する。
 */
export const EVENT_CAPACITY_CEILING = 200;

/**
 * 1〜{@link EVENT_CAPACITY_CEILING} の整数だけを通す SSM parameter `allowedPattern`。
 * SSM の Integer 型 parameter には範囲制約が無いため String + regex で構造的に縛る。
 */
export const EVENT_CAPACITY_PARAM_PATTERN = "^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$";
