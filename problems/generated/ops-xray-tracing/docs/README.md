# X-Ray 分散トレーシング構成

## 概要

API Gateway + Lambda に X-Ray 分散トレーシングを有効化し、サンプリングルールとグループを構成する構築型問題です。

## 対象サービス

- AWS X-Ray
- Amazon API Gateway
- AWS Lambda

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| API Gateway トレーシング | X-Ray トレーシング有効化 | 25 点 |
| Lambda トレーシング | アクティブトレーシング有効化 | 25 点 |
| サンプリングルール | カスタムサンプリングルール | 20 点 |
| X-Ray グループ | フィルタ式を持つグループ | 15 点 |
| IAM ロール | X-Ray 権限 IAM ロール | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetStage` で TracingEnabled が true であるか
2. `GetFunction` で TracingConfig.Mode が Active であるか
3. `GetSamplingRules` でカスタムルールが存在するか
4. `GetGroups` でグループが存在するか
5. `GetRole` で X-Ray 権限が付与されているか

## 参考ドキュメント

- [X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/aws-xray.html)
- [X-Ray サンプリングルール](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html)
