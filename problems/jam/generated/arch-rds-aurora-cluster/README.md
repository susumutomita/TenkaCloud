# Aurora MySQL クラスター + リードレプリカ構成

## 概要

Aurora MySQL クラスターをリードレプリカ付きで構築し、パラメータグループでチューニングする構築型問題です。

## 対象サービス

- Amazon Aurora (MySQL)
- Amazon RDS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| DB サブネットグループ | 2 AZ プライベートサブネット | 20 点 |
| Aurora クラスター | 暗号化有効 | 30 点 |
| ライター + リーダー | 2 インスタンス構成 | 30 点 |
| パラメータグループ | UTF-8mb4 文字コード設定 | 20 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeDBSubnetGroups` でサブネットグループを確認
2. `DescribeDBClusters` でクラスター設定と暗号化を確認
3. `DescribeDBInstances` でインスタンス数とロールを確認
4. `DescribeDBClusterParameterGroups` でパラメータを確認

## 参考ドキュメント

- [Amazon Aurora MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMySQL.html)
- [Aurora リードレプリカ](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html)
