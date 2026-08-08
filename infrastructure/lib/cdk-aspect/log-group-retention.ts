import type { IAspect } from "aws-cdk-lib";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import type { IConstruct } from "constructs";
import { LAMBDA_LOG_RETENTION } from "../utils/lambda-runtime.js";

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
 * ## 届かない範囲 (#2960 の実測。 コメントを実態に合わせておく)
 *
 * 上の「各 Lambda に明示 LogGroup を持たせた上で」という前提は、 **全 Lambda では満たされていない**。
 * 本 Aspect の実装は `node instanceof CfnLogGroup` なので、 CFn resource として存在する log group
 * にしか届かない。 明示 LogGroup を持たない Lambda の log group は初回実行時に Lambda サービスが
 * 暗黙に作るため、 Aspect の視界にも synth 出力にも入らない。
 *
 * 2026-08-08 の実測では、 destroy 後に残った 48 個のうち **29 個が retention 未設定**で、 その内訳は
 * いずれも CDK 自身が生成する custom resource provider の Lambda と CodeBuild だった。
 *
 *   - `/aws/lambda/*-CustomCDKBucketDeployment-*`
 *   - `/aws/lambda/*-CustomS3AutoDeleteObject-*`
 *   - `/aws/lambda/*-CustomAWSCDKOpenIdConnec-*`
 *   - `/aws/codebuild/*`
 *
 * 一方 `/aws/lambda/tenkacloud-control-plane-AWS679f53fac002430cb0da5b-*` は retention=1 だった。
 * **Aspect 自体は正しく動いており、 届かない経路があるだけ**である。 したがって
 * 「本 Aspect があるからコスト 0」 とは言えない。 現時点で塞げているのは synth に現れる分だけで
 * (`test/app-wiring/log-group-retention-coverage.test.ts` が全件 assertion で固定している)、
 * 暗黙生成分は `scripts/cleanup.sh` の log group sweep が destroy 時に回収する。 deploy 中の
 * 無期限保持そのものは未解決で、 上記 provider へ retention を通す手当ては入っていない。
 *
 * 設計: 値は `lambda-runtime.ts` の `LAMBDA_LOG_RETENTION` (= `resolveLogRetention` で検証済の
 * `RetentionDays` enum、 値は日数そのもの) を直接参照する。 検証済 enum を使うことで、 サポート外の
 * `CDK_PARAM_LOG_RETENTION_DAYS` は module load (= synth) 時に例外で停止する (fail loudly、 deploy
 * まで持ち越さない)。 `DynamoDbLowCapacity` のように caller から渡さないのは、 retention は環境横断で
 * 1 つの param に閉じており (= per-stack で変える要件が無い) import で source of truth を 1 ヶ所に
 * 保てるため。
 *
 * memory: コスト 0 原則。 training / demo 用途のログは短期保持で十分。
 */
export class LogGroupRetention implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnLogGroup)) return;
    node.retentionInDays = LAMBDA_LOG_RETENTION;
  }
}
