# API Gateway スロットリングとレスポンスキャッシュ

## 概要

API Gateway に使用量プラン、API キー、キャッシュ、リクエストバリデーションを設定してパフォーマンスを安定化する構築型問題です。

## 対象サービス

- Amazon API Gateway
- AWS Lambda

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| 使用量プラン | レート 50、バースト 100、日次 10000 | 30 点 |
| API キー | API キーを使用量プランに関連付け | 25 点 |
| キャッシュ | TTL 60 秒のキャッシュ | 25 点 |
| リクエストバリデーション | バリデーション有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetUsagePlan` でレート 50、バースト 100、クォータ 10000/DAY であるか
2. `GetUsagePlanKeys` で API キーが関連付けられているか
3. `GetStage` でキャッシュが有効で TTL 60 秒であるか
4. `GetRequestValidators` でバリデーターが有効であるか

## 参考ドキュメント

- [API Gateway 使用量プラン](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html)
- [API Gateway キャッシュ](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html)
