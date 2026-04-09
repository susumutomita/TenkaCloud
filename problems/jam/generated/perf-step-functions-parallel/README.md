# Step Functions 並列実行と Map ステートによる高速処理

## 概要

Step Functions の Parallel ステートと Map ステートを活用してワークフロー処理を高速化する構築型問題です。

## 対象サービス

- AWS Step Functions
- AWS Lambda

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Parallel ステート | 3 Lambda を同時実行 | 30 点 |
| Map ステート | アイテム並列処理 | 25 点 |
| 同時実行制御 | MaxConcurrency 10 | 20 点 |
| エラーハンドリング | Catch + Retry | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeStateMachine` の Definition に Parallel ステート（3 分岐）が含まれるか
2. `DescribeStateMachine` の Definition に Map ステートが含まれるか
3. Map ステートの MaxConcurrency が 10 であるか
4. Definition に Catch と Retry が含まれるか

## 参考ドキュメント

- [Step Functions Parallel ステート](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-parallel-state.html)
- [Step Functions Map ステート](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-map-state.html)
