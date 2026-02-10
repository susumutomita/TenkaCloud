# CloudFormation ドリフト検出と自動修復

## 概要

Config ルールと Lambda を使い、CloudFormation スタックのドリフトを定期検出し通知する仕組みを構築する構築型問題です。

## 対象サービス

- AWS CloudFormation
- AWS Config
- AWS Lambda
- Amazon EventBridge
- Amazon SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Config ルール | ドリフト検出 Config ルール | 25 点 |
| EventBridge ルール | 定期実行スケジュール | 20 点 |
| Lambda 関数 | ドリフト検出 Lambda | 25 点 |
| SNS 通知 | ドリフト検出通知 | 15 点 |
| IAM ロール | 必要な IAM ロール | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeConfigRules` でドリフト検出ルールが存在するか
2. `ListRules` でスケジュールルールが存在するか
3. `GetFunction` でドリフト検出 Lambda が存在するか
4. `ListTopics` で SNS トピックが存在するか
5. `GetRole` で必要な IAM ロールが存在するか

## 参考ドキュメント

- [CloudFormation ドリフト検出](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Config ルール](https://docs.aws.amazon.com/config/latest/developerguide/cloudformation-stack-drift-detection-check.html)
