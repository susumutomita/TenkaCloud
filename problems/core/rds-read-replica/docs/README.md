# RDS リードレプリカとコネクションプーリング

## 概要

Aurora MySQL クラスターにリードレプリカと RDS Proxy を構成し、読み取りパフォーマンスとコネクション管理を最適化する構築型問題です。

## 対象サービス

- Amazon Aurora (MySQL)
- Amazon RDS Proxy

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Aurora クラスター | Aurora MySQL クラスター + ストレージ暗号化 | 25 点 |
| リードレプリカ | ライター + リーダーの 2 インスタンス構成 | 30 点 |
| RDS Proxy | コネクションプーリング構成 | 25 点 |
| Performance Insights | パフォーマンスモニタリング有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeDBClusters` で Aurora MySQL クラスターが存在し StorageEncrypted が true か
2. `DescribeDBInstances` でクラスターに 2 インスタンス（writer + reader）が存在するか
3. `DescribeDBProxies` で RDS Proxy が存在しクラスターに関連付けられているか
4. `DescribeDBInstances` で EnablePerformanceInsights が true か

## 参考ドキュメント

- [Aurora DB クラスター](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.html)
- [Aurora リードレプリカ](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Replication.html)
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Performance Insights](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html)
