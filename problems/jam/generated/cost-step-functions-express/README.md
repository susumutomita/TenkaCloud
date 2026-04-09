# Step Functions Express Workflows でコスト削減

## 概要

Step Functions を Standard から Express Workflow に移行してコストを削減する構築型問題です。

## 対象サービス

- AWS Step Functions
- AWS Lambda

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Express Workflow | Type を EXPRESS に設定 | 30 点 |
| Lambda 統合 | 2 つの Lambda 関数を統合 | 25 点 |
| ログ設定 | CloudWatch Logs、レベル ALL | 25 点 |
| X-Ray トレース | トレースを有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeStateMachine` で Type が EXPRESS であるか
2. `DescribeStateMachine` の Definition に 2 つの Lambda タスクが含まれるか
3. `DescribeStateMachine` で LoggingConfiguration の Level が ALL であるか
4. `DescribeStateMachine` で TracingConfiguration が有効であるか

## 参考ドキュメント

- [Step Functions Express Workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-standard-vs-express.html)
- [Step Functions ログ](https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html)
