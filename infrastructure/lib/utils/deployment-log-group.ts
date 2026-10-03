import { RemovalPolicy } from "aws-cdk-lib";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { LAMBDA_LOG_RETENTION } from "./lambda-runtime.js";

/**
 * `BucketDeployment` の custom resource Lambda に持たせる明示 LogGroup (#2960)。
 *
 * ## なぜ要るか
 *
 * `LogGroupRetention` Aspect は `CfnLogGroup` にしか届かない。 log group を CFn resource として
 * 作っていない Lambda では、 log group は初回実行時に Lambda サービスが暗黙生成する — synth 出力に
 * 現れないので Aspect の視界に入らず、 retention は **Never expire** になる。
 *
 * 2026-08-08 の実測で、 destroy 後に残っていた 48 個のうち 29 個が retention 未設定で、 その多くが
 * CDK 内製 custom resource provider の Lambda だった。 残骸が残ること自体より、 **残った分の保存
 * 料金が永久に発生する**ことのほうが効く。
 *
 * `BucketDeployment` は `logGroup` prop を受け取れる (aws-cdk-lib 2.262.1 で確認。 `logRetention` は
 * deprecated で、 doc が `logGroup` への移行を勧めている)。 だから明示 LogGroup を渡す。 渡した
 * LogGroup は synth 出力に現れるので、 Aspect の視界に入り、 retention が当たる。
 *
 * ## 塞げない経路
 *
 * 同じ手当てが効かない provider がある。 `Bucket({ autoDeleteObjects: true })` の
 * `Custom::S3AutoDeleteObjects` と `iam.OpenIdConnectProvider` の
 * `Custom::AWSCDKOpenIdConnectProvider` は、 いずれも provider Lambda を construct 内部で singleton
 * として作り、 log 設定の prop を公開していない (2.262.1 の型定義で確認)。 この 2 経路は構築側からは
 * 塞げないので、 `scripts/enforce-log-retention.sh` の backstop sweep が deploy 後に回収する。
 * 「全部塞いだ」とは言えない。
 */
/**
 * ## 同じ stack の `BucketDeployment` は provider Lambda を共有する
 *
 * CDK は `BucketDeployment` の provider Lambda を **stack ごとの singleton** (memory 等の props
 * で分かれる) として作る。 同じ handler を使う 2 つの deployment にそれぞれ別の LogGroup を
 * 渡すと、 効くのは片方だけで、 もう片方は **誰も使わない log group** として stack に残る。
 * 掃除されない resource を減らす issue で掃除されない resource を増やしては本末転倒なので、
 * handler を共有する呼び出しでは同じ LogGroup を渡し直す (`deploymentLogGroup` を 1 度だけ
 * 呼んで使い回す)。 synth 後に `AWS::Logs::LogGroup` の参照を数えれば、 増やした分が全部
 * 参照されていることを確認できる。
 */
export function deploymentLogGroup(scope: Construct, id: string): LogGroup {
  return new LogGroup(scope, id, {
    // 派生物のログなので stack と一緒に消えてよい。 残すと destroy 後の残骸になる。
    removalPolicy: RemovalPolicy.DESTROY,
    // Aspect も同じ値を当てるが、 ここでも明示する。 省略すると CDK 既定の 2 年が synth に出て、
    // Aspect を外した瞬間に 2 年保持へ黙って戻る。 同じ `LAMBDA_LOG_RETENTION` を参照しているので
    // source of truth は 1 つのまま。
    retention: LAMBDA_LOG_RETENTION,
  });
}
