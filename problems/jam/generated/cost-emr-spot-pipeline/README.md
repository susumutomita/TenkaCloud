# EMR Serverless によるバッチ処理コスト最適化

## 概要

EMR on EC2 から EMR Serverless に移行し、リソース制限と自動停止で大規模バッチ処理のコストを最適化する Expert 問題です。

## 対象サービス

- Amazon EMR Serverless
- Amazon S3

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EMR Serverless | Spark タイプのアプリケーション | 25 点 |
| リソース制限 | 最大 4 vCPU、16 GB | 20 点 |
| 自動停止設定 | 15 分アイドルタイムアウト | 20 点 |
| 入力バケット | 90 日 Glacier 移行ルール | 20 点 |
| 出力バケット | Intelligent-Tiering 有効 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetApplication` で Type が Spark であるか
2. `GetApplication` で MaximumCapacity が 4 vCPU / 16 GB であるか
3. `GetApplication` で AutoStopConfiguration が有効で IdleTimeoutMinutes=15 であるか
4. `GetBucketLifecycleConfiguration` で 90 日 Glacier 移行ルールがあるか
5. `GetBucketIntelligentTieringConfiguration` で Intelligent-Tiering が有効であるか

## 参考ドキュメント

- [EMR Serverless](https://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/emr-serverless.html)
- [S3 Intelligent-Tiering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering.html)
