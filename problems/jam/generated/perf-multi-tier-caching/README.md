# マルチ層キャッシュアーキテクチャの構築

## 概要

CloudFront、API Gateway キャッシュ、ElastiCache Redis を組み合わせた 3 層キャッシュアーキテクチャを構築する Expert 問題です。

## 対象サービス

- Amazon CloudFront
- Amazon API Gateway
- Amazon ElastiCache (Redis)
- AWS Lambda

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CloudFront キャッシュ | TTL 300 秒 / 最大 3600 秒 | 20 点 |
| API Gateway キャッシュ | TTL 60 秒 | 20 点 |
| ElastiCache Redis | 1+2 構成、暗号化 | 25 点 |
| Redis パフォーマンス | allkeys-lfu、自動フェイルオーバー | 20 点 |
| Lambda VPC 配置 | VPC 内に配置 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetCachePolicy` で DefaultTTL=300、MaxTTL=3600 であるか
2. `GetStage` で CacheClusterEnabled=true、CacheTtlInSeconds=60 であるか
3. `DescribeReplicationGroups` で 3 ノード構成、暗号化有効であるか
4. `DescribeCacheParameterGroups` で allkeys-lfu、AutomaticFailoverEnabled=true であるか
5. `GetFunctionConfiguration` で VpcConfig が設定されているか

## 参考ドキュメント

- [CloudFront キャッシュポリシー](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html)
- [ElastiCache Redis レプリケーション](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Replication.html)
- [Lambda VPC 接続](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
