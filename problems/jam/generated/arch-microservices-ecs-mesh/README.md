# ECS マイクロサービス + Service Connect 構成

## 概要

ECS Fargate で 3 つのマイクロサービスを構築し、Service Connect によるサービス間通信とセキュリティグループ連鎖を実装する構築型問題です。

## 対象サービス

- Amazon ECS (Fargate)
- AWS Cloud Map
- Elastic Load Balancing (ALB)
- CloudWatch Logs

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ECS クラスター | Container Insights 有効 | 10 点 |
| 3 サービス構成 | API GW + User + Order | 25 点 |
| Service Connect | Cloud Map + Service Connect | 25 点 |
| ALB 外部公開 | API GW のみ公開 | 15 点 |
| SG 連鎖 | 外部 → API GW → 内部 | 15 点 |
| ログ | CloudWatch Logs 出力 | 10 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeClusters` でクラスター設定と Container Insights を確認
2. `DescribeServices` で 3 サービスの存在と設定を確認
3. `ListNamespaces` と Service Connect 設定を確認
4. ALB とセキュリティグループの設定を確認

## 参考ドキュメント

- [ECS Service Connect](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html)
- [AWS Cloud Map](https://docs.aws.amazon.com/cloud-map/latest/dg/what-is-cloud-map.html)
