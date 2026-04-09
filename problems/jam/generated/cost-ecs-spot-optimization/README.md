# ECS クラスターの Spot + オンデマンド混合戦略

## 概要

ECS Fargate クラスターに Spot とオンデマンドの混合キャパシティプロバイダー戦略を構成してコストを削減する構築型問題です。

## 対象サービス

- Amazon ECS (Fargate)

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| キャパシティプロバイダー | FARGATE + FARGATE_SPOT 登録 | 25 点 |
| API サービス | FARGATE のみ | 25 点 |
| バッチサービス | FARGATE_SPOT:3, FARGATE:1 混合 | 30 点 |
| サーキットブレーカー | デプロイメントサーキットブレーカー有効 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeClusters` で FARGATE と FARGATE_SPOT が登録されているか
2. `DescribeServices` で API サービスが FARGATE のみ使用しているか
3. `DescribeServices` でバッチサービスが FARGATE_SPOT:3, FARGATE:1 であるか
4. `DescribeServices` で DeploymentCircuitBreaker が有効であるか

## 参考ドキュメント

- [ECS キャパシティプロバイダー](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-capacity-providers.html)
- [Fargate Spot](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
