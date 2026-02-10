# Private API Gateway + VPC エンドポイント

## 概要

Private API Gateway を VPC エンドポイント経由でのみアクセス可能にし、API キーと使用量プランで制御する構築型問題です。

## 対象サービス

- Amazon API Gateway (Private)
- Amazon VPC Endpoints
- AWS Lambda

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| VPC エンドポイント | Interface エンドポイント | 20 点 |
| Private API | PRIVATE エンドポイント | 20 点 |
| リソースポリシー | VPC エンドポイント制限 | 25 点 |
| Lambda 統合 | Lambda プロキシ統合 | 15 点 |
| API キー + 使用量 | キー認証 + スロットリング | 20 点 |

## 参考ドキュメント

- [Private API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-apis.html)
- [API キーと使用量プラン](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html)
