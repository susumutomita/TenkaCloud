# マルチリージョン Active-Active 構成

## 概要

Route 53、DynamoDB Global Tables、S3 CRR、CloudFront を組み合わせたマルチリージョン Active-Active 構成を構築する構築型問題です。

## 対象サービス

- Amazon Route 53
- Amazon DynamoDB Global Tables
- Amazon S3 (Cross-Region Replication)
- Amazon CloudFront
- AWS Certificate Manager

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Route 53 | レイテンシーベース + ヘルスチェック | 25 点 |
| DynamoDB Global Tables | 2 リージョンレプリケーション | 25 点 |
| S3 CRR | クロスリージョンレプリケーション | 20 点 |
| CloudFront | オリジングループフェイルオーバー | 20 点 |
| ACM | SSL 証明書 | 10 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. Route 53 レコードとヘルスチェックを確認
2. DynamoDB Global Table のレプリカを確認
3. S3 レプリケーション設定を確認
4. CloudFront オリジングループを確認
5. ACM 証明書を確認

## 参考ドキュメント

- [DynamoDB Global Tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [S3 クロスリージョンレプリケーション](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
