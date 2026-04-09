# マルチサービスコスト最適化

## 概要

CloudFront、Lambda、DynamoDB の 3 サービスにまたがるコスト最適化を行う構築型問題です。

## 対象サービス

- Amazon CloudFront
- AWS Lambda
- Amazon DynamoDB

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CloudFront キャッシュ最適化 | TTL 設定（デフォルト 86400 秒、最大 604800 秒）+ 圧縮有効化 | 30 点 |
| Lambda メモリ最適化 | メモリ 256 MB、タイムアウト 10 秒 | 25 点 |
| DynamoDB オンデマンドモード | BillingMode: PAY_PER_REQUEST | 25 点 |
| DynamoDB TTL 有効化 | TimeToLiveSpecification の有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetCachePolicy` でデフォルト TTL が 86400 秒、最大 TTL が 604800 秒、圧縮が有効か
2. `GetFunction` でメモリが 256 MB、タイムアウトが 10 秒以内か
3. `DescribeTable` で BillingMode が PAY_PER_REQUEST か
4. `DescribeTimeToLive` で TimeToLiveStatus が ENABLED か

## 参考ドキュメント

- [CloudFront キャッシュポリシー](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html)
- [Lambda メモリとコンピューティング](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-common.html)
- [DynamoDB 読み書きキャパシティモード](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadWriteCapacityMode.html)
- [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
