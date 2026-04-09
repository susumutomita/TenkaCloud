# ElastiCache レプリケーショングループによる高可用性キャッシュ

## 概要

ElastiCache Redis レプリケーショングループを構成し、自動フェイルオーバーと暗号化を備えた高可用性キャッシュを構築する構築型問題です。

## 対象サービス

- Amazon ElastiCache (Redis)
- Amazon VPC

## 可用性要件

| 要件 | 内容 | 配点 |
|------|------|------|
| レプリケーショングループ | マルチ AZ + リードレプリカ 1 台以上 | 30 点 |
| 自動フェイルオーバー | AutomaticFailover の有効化 | 25 点 |
| 暗号化 | 転送中 + 保管時暗号化 | 25 点 |
| サブネットグループ | 複数 AZ のキャッシュサブネットグループ | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeReplicationGroups` でレプリケーショングループが存在しリードレプリカがあるか
2. `DescribeReplicationGroups` で AutomaticFailover が enabled であるか
3. `DescribeReplicationGroups` で TransitEncryptionEnabled と AtRestEncryptionEnabled が true であるか
4. `DescribeCacheSubnetGroups` でサブネットが 2 つ以上の AZ に分散しているか

## 参考ドキュメント

- [ElastiCache Redis レプリケーション](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Replication.html)
- [ElastiCache 暗号化](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/at-rest-encryption.html)
