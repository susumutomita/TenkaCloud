# Global Accelerator マルチリージョンフェイルオーバー

## 概要

AWS Global Accelerator を使い、Anycast IP によるグローバルエントリポイントとマルチリージョン自動フェイルオーバーを構築する構築型問題です。

## 対象サービス

- AWS Global Accelerator
- Elastic Load Balancing (ALB)
- Amazon VPC

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Global Accelerator | アクセラレーター + リスナー | 20 点 |
| エンドポイントグループ | 2 リージョンのエンドポイントグループ | 25 点 |
| ヘルスチェック | エンドポイントグループのヘルスチェック | 20 点 |
| ALB エンドポイント | 各リージョンの ALB 登録 | 20 点 |
| トラフィック配分 | プライマリリージョン 100％ 配分 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `ListAccelerators` でアクセラレーターが存在するか
2. `ListEndpointGroups` で 2 リージョンにグループが存在するか
3. `DescribeEndpointGroup` でヘルスチェックが設定されているか
4. `DescribeEndpointGroup` で ALB がエンドポイントに登録されているか
5. `DescribeEndpointGroup` で TrafficDialPercentage が正しく設定されているか

## 参考ドキュメント

- [Global Accelerator](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [エンドポイントグループ](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups.html)
