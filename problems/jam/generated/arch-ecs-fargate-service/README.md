# ECS Fargate サービス + ALB 統合

## 概要

ECS Fargate でコンテナ化された Web アプリケーションを ALB 経由で公開する構築型問題です。

## 対象サービス

- Amazon ECS (Fargate)
- Elastic Load Balancing (ALB)
- CloudWatch Logs

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ECS クラスター | クラスター作成 | 15 点 |
| タスク定義 + ログ | Fargate タスク定義 + CloudWatch Logs | 30 点 |
| ALB + ターゲットグループ | ALB 作成 + ヘルスチェック | 25 点 |
| ECS サービス | ALB 統合 + デプロイ設定 | 30 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeClusters` でクラスターの存在を確認
2. `DescribeTaskDefinition` でタスク定義の設定を確認
3. `DescribeTargetGroups` でヘルスチェック設定を確認
4. `DescribeServices` でサービス設定と ALB 統合を確認

## 参考ドキュメント

- [Amazon ECS on Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [ECS サービスの ALB 統合](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html)
