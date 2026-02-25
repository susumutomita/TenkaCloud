# API Gateway キャッシュによるバックエンドコスト削減

## 概要

API Gateway のキャッシュとスロットリングを設定してバックエンド Lambda のコストを削減する構築型問題です。

## 対象サービス

- Amazon API Gateway
- AWS Lambda

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| API Gateway キャッシュ | 0.5 GB、TTL 300 秒 | 30 点 |
| スロットリング設定 | 100 req/sec、バースト 200 | 25 点 |
| Lambda 統合 | Lambda 関数を統合 | 25 点 |
| アクセスログ | ステージのアクセスログ有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetStage` で CacheClusterEnabled が true、CacheClusterSize が 0.5 であるか
2. `GetStage` で ThrottlingRateLimit=100, ThrottlingBurstLimit=200 であるか
3. `GetMethod` で Lambda 統合が設定されているか
4. `GetStage` で AccessLogSetting が設定されているか

## 参考ドキュメント

- [API Gateway キャッシュ](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html)
- [API Gateway スロットリング](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
