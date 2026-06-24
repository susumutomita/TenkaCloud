import type { IAspect } from "aws-cdk-lib";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import type { IConstruct } from "constructs";
import { LAMBDA_LOG_RETENTION_DAYS } from "../utils/lambda-runtime.js";

/**
 * 全ての CloudWatch `LogGroup` の retention を `CDK_PARAM_LOG_RETENTION_DAYS` (既定 1 日) に
 * 強制的に揃える Aspect。
 *
 * 用途: Lambda は LogGroup を明示しないと "Never expire" (= 無限保持) の log group を勝手に作る。
 * これがコスト leak になるため、 各 Lambda に明示 LogGroup を持たせた上で本 Aspect が retention を
 * 一括設定する。 retention を Aspect 側に集約することで、 `CDK_PARAM_LOG_RETENTION_DAYS` を
 * **単一の source of truth** にできる (= 個々の LogGroup に inline で値を散らさない)。
 *
 * 対象:
 *   - 全 `AWS::Logs::LogGroup` (Lambda 用 / state machine 用 / SBT 等 third-party 製も含む)
 *   - retention が既に設定済みでも **上書き** する (= param が常に勝つ)
 *
 * 設計: 値は `lambda-runtime.ts` の `LAMBDA_LOG_RETENTION_DAYS` (env 由来) を直接参照する。
 * `DynamoDbLowCapacity` のように caller から渡す形にしないのは、 retention は環境横断で 1 つの
 * param に閉じており (= per-stack で変える要件が無い)、 import で source of truth を 1 ヶ所に
 * 保てるため。
 *
 * memory: コスト 0 原則。 training / demo 用途のログは短期保持で十分。
 */
export class LogGroupRetention implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnLogGroup)) return;
    node.retentionInDays = LAMBDA_LOG_RETENTION_DAYS;
  }
}
