import * as cdk from "aws-cdk-lib";
import type { AppConfig } from "../../app-config/types.js";
import { CodeBuildUseAwsManagedKms } from "../../cdk-aspect/codebuild-use-aws-managed-kms.js";
import { DynamoDbLowCapacity } from "../../cdk-aspect/dynamodb-low-capacity.js";
import { KmsKeyShortPendingWindow } from "../../cdk-aspect/kms-key-short-pending-window.js";
import { LogGroupRetention } from "../../cdk-aspect/log-group-retention.js";

/**
 * Issue #766 wire-split: App scope に効く global Tags / Aspects を 1 ヶ所に集約する。
 *
 * `buildTenkaCloudApp` の冒頭で 1 回だけ呼ぶ。 ここで付与する Tag / Aspect は `cdk.App` scope なので
 * 配下の全 stack の CFn template に等しく波及する (= 個別 stack を生成する前に呼ぶ必要がある)。
 * 関数の副作用は App への Tag / Aspect 追加のみで戻り値を持たない。
 */
export function applyGlobalAspects(app: cdk.App, config: AppConfig): void {
  // Issue #952 / PR-957 user feedback: cost allocation tag を App scope で全リソースに
  // 強制付与する。 名前 prefix 識別ではなく tag で resource ownership を表明することで:
  //   - 同一 AWS account 内に他 workload があっても混ざらない (= cost / drift / cleanup 識別)
  //   - AWS Budgets / Cost Explorer の `TagKeyValue` filter (= `user:Project$TenkaCloud`) で
  //     TenkaCloud 分だけを抽出して予算管理できる
  //   - user は AWS Billing console で 1 回 "Project" tag を "Cost Allocation Tag" として
  //     activate する必要がある (= 既存リソースへの遡及反映には最大 24h)
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", config.environment);

  // App scope Aspect: KMS Key 削除待機期間を `config.kmsPendingWindowInDays` に揃える。
  // SBT が内部生成する CodeBuild EncryptionKey 等も含む全 `AWS::KMS::Key` が対象。
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(config.kmsPendingWindowInDays));

  // SBT BashJobRunner が CodeBuild project artifact 暗号化用に作る customer-managed
  // KMS Key を AWS-managed alias `alias/aws/s3` (無料) に置き換える Aspect (cost cleanup)。
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  // PR #2021: 全 stack の LogGroup retention を `CDK_PARAM_LOG_RETENTION_DAYS` (既定 1 日) に
  // 揃え、 "Never expire" log group を一掃する Aspect (= 上の KMS / CodeBuild cost aspect と同列)。
  cdk.Aspects.of(app).add(new LogGroupRetention());
}

/**
 * SBT が ControlPlane / ProblemDeploy 内部で作る DynamoDB Table は CDK Table の既定値 (5/5) なので
 * Free Tier 枠 (25 RCU/WCU) を圧迫する。 対象 stack に `DynamoDbLowCapacity` Aspect を付け、 全
 * `CfnTable` を `config.dynamoReadCapacity` / `config.dynamoWriteCapacity` (default 1/1) に揃える。
 */
export function applyDynamoLowCapacity(scope: cdk.Stack, config: AppConfig): void {
  cdk.Aspects.of(scope).add(
    new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
  );
}
