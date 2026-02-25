# データレイク + ETL パイプライン構成

## 概要

S3 3 層構成、Kinesis Firehose、Glue、Athena、Lake Formation を組み合わせたデータレイク基盤を構築する構築型問題です。

## 対象サービス

- Amazon S3
- Amazon Kinesis Data Firehose
- AWS Glue
- Amazon Athena
- AWS Lake Formation

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| S3 3 層 | Raw/Processed/Curated | 15 点 |
| Firehose | リアルタイムデータ取り込み | 20 点 |
| Glue カタログ | DB + テーブル定義 | 20 点 |
| Glue ETL | Raw → Processed 変換 | 20 点 |
| Athena | ワークグループ + 暗号化 | 15 点 |
| Lake Formation | アクセス権限管理 | 10 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. S3 バケットの存在と暗号化設定を確認
2. `DescribeDeliveryStream` で Firehose 設定を確認
3. `GetDatabase` と `GetTable` で Glue カタログを確認
4. `GetJob` で Glue ETL ジョブを確認
5. `GetWorkGroup` で Athena ワークグループを確認
6. Lake Formation 設定を確認

## 参考ドキュメント

- [AWS データレイクアーキテクチャ](https://docs.aws.amazon.com/whitepapers/latest/building-data-lakes/building-data-lake-aws.html)
- [AWS Glue ETL](https://docs.aws.amazon.com/glue/latest/dg/aws-glue-programming-etl.html)
