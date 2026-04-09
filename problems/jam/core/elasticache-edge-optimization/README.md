# ElastiCache と Lambda@Edge によるパフォーマンス最適化

## 概要

ElastiCache Redis クラスターと CloudFront + Lambda@Edge を組み合わせた多層キャッシュアーキテクチャを構築する構築型問題です。

## 対象サービス

- Amazon ElastiCache (Redis)
- AWS Lambda@Edge
- Amazon CloudFront

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ElastiCache Redis クラスター | 1+1 レプリケーション構成 + 暗号化 | 30 点 |
| Redis パフォーマンス設定 | allkeys-lru + 自動フェイルオーバー | 20 点 |
| Lambda@Edge 関数 | viewer-request イベントで動作するエッジ関数 | 25 点 |
| CloudFront + Lambda@Edge 連携 | ディストリビューションに Lambda@Edge を関連付け | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeReplicationGroups` でレプリケーショングループが存在し、NumCacheClusters=2、暗号化が有効か
2. `DescribeCacheParameters` で maxmemory-policy が allkeys-lru、AutomaticFailoverEnabled が true か
3. `GetFunction` で Lambda@Edge 関数が us-east-1 にデプロイされているか
4. `GetDistribution` の LambdaFunctionAssociations に viewer-request の Lambda@Edge が設定されているか

## アーキテクチャ

```
User --> CloudFront (Lambda@Edge) --> S3 Origin
              |
         Edge Cache
              |
         Application --> ElastiCache Redis --> DynamoDB
```

## 参考ドキュメント

- [ElastiCache for Redis](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html)
- [Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-the-edge.html)
- [CloudFront と Lambda@Edge の統合](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html)
- [ElastiCache ベストプラクティス](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.html)
