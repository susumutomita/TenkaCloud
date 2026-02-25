# Lambda Provisioned Concurrency によるコールドスタート排除

## 概要

Lambda 関数に Provisioned Concurrency を設定してコールドスタートを排除する構築型問題です。

## 対象サービス

- AWS Lambda

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Lambda バージョン | バージョンを発行 | 20 点 |
| Lambda エイリアス | prod エイリアスを作成 | 25 点 |
| Provisioned Concurrency | 5 同時実行を予約 | 35 点 |
| 関数 URL | IAM 認証付き URL | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `ListVersionsByFunction` でバージョンが発行されているか
2. `GetAlias` で prod エイリアスが存在するか
3. `GetProvisionedConcurrencyConfig` で 5 が設定されているか
4. `GetFunctionUrlConfig` で AuthType が AWS_IAM であるか

## 参考ドキュメント

- [Lambda Provisioned Concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)
- [Lambda 関数 URL](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)
