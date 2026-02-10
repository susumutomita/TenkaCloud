# Global Accelerator によるマルチリージョン API 高速化

## 概要

AWS Global Accelerator を使用してマルチリージョンの ALB にトラフィックを分散し、グローバル API のレイテンシを改善する Expert 問題です。

## 対象サービス

- AWS Global Accelerator
- Elastic Load Balancing (ALB)

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Global Accelerator | ポート 443 のリスナー | 20 点 |
| エンドポイントグループ | 2 リージョン構成 | 25 点 |
| ヘルスチェック | 10 秒間隔 | 20 点 |
| トラフィックダイヤル | 100% | 15 点 |
| ALB エンドポイント | クライアント IP 保持有効 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeAccelerator` でアクセラレーターが存在し、リスナーにポート 443 があるか
2. `ListEndpointGroups` で 2 リージョンのグループが存在するか
3. `DescribeEndpointGroup` で HealthCheckIntervalSeconds が 10 であるか
4. `DescribeEndpointGroup` で TrafficDialPercentage が 100 であるか
5. エンドポイント構成で ClientIPPreservationEnabled が true であるか

## 参考ドキュメント

- [Global Accelerator](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [エンドポイントグループ](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups.html)
