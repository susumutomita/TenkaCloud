# Redshift Spectrum と S3 データレイクによるクエリコスト最適化

## 概要

Redshift Serverless と Glue Data Catalog を使用し、S3 のデータを Spectrum 経由でクエリする構成を構築してコストを削減する問題です。

## 対象サービス

- Amazon Redshift Serverless
- AWS Glue Data Catalog
- Amazon S3

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Redshift Serverless | ワークグループとネームスペース | 30 点 |
| ベース RPU 設定 | 8 RPU に設定 | 20 点 |
| Glue Database | Data Catalog にデータベース作成 | 25 点 |
| Glue テーブル | S3 外部テーブルを定義 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetWorkgroup` でワークグループが存在するか
2. `GetWorkgroup` で BaseCapacity が 8 であるか
3. `GetDatabase` で Glue データベースが存在するか
4. `GetTable` で Glue 外部テーブルが定義されているか

## 参考ドキュメント

- [Redshift Serverless](https://docs.aws.amazon.com/redshift/latest/mgmt/serverless-workgroup-namespace.html)
- [Redshift Spectrum](https://docs.aws.amazon.com/redshift/latest/dg/c-using-spectrum.html)
- [Glue Data Catalog](https://docs.aws.amazon.com/glue/latest/dg/catalog-and-crawler.html)
