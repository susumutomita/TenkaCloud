# API Gateway + Lambda REST API 構成

## 概要

API Gateway と Lambda を使ってサーバーレスの REST API を構築する構築型問題です。

## 対象サービス

- Amazon API Gateway
- AWS Lambda
- IAM

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Lambda 関数 + IAM | Lambda 関数と実行ロール | 25 点 |
| REST API + メソッド | GET/POST + Lambda プロキシ統合 | 30 点 |
| スロットリング | レート制限 + バースト制限 | 20 点 |
| CORS | OPTIONS メソッド + レスポンスヘッダー | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `GetFunction` で Lambda 関数の設定を確認
2. `GetResources` と `GetMethod` で API リソースとメソッドを確認
3. `GetStage` でスロットリング設定を確認
4. OPTIONS メソッドのレスポンスヘッダーを確認

## 参考ドキュメント

- [API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html)
- [Lambda プロキシ統合](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)
