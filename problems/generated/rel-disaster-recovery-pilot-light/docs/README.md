# ディザスタリカバリ パイロットライト構成

## 概要

コスト効率の良いパイロットライト DR 戦略を実装し、障害時に自動的に DR インフラを起動する構成を構築する Expert レベルの構築型問題です。

## 対象サービス

- Amazon RDS (リードレプリカ)
- Amazon EC2 Auto Scaling
- Amazon Route 53
- AWS Lambda
- Amazon EventBridge

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| RDS リードレプリカ | DR 用クロスリージョンリードレプリカ | 20 点 |
| 起動テンプレート | DR リージョン用起動テンプレート | 10 点 |
| 待機 Auto Scaling | 最小容量 0 の待機 ASG | 15 点 |
| Route 53 フェイルオーバー | DNS フェイルオーバーレコード | 20 点 |
| Lambda 自動復旧 | DR インフラ起動 Lambda | 20 点 |
| EventBridge ルール | ヘルスチェック失敗トリガー | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeDBInstances` でリードレプリカが存在するか
2. `DescribeLaunchTemplates` で DR 用起動テンプレートが存在するか
3. `DescribeAutoScalingGroups` で MinSize=0 の ASG が存在するか
4. `ListResourceRecordSets` でフェイルオーバーレコードが存在するか
5. `GetFunction` で DR 起動 Lambda が存在するか
6. `ListRules` で EventBridge ルールが存在するか

## 参考ドキュメント

- [DR 戦略: パイロットライト](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [RDS リードレプリカ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
