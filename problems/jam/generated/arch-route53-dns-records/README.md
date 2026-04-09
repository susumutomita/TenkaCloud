# Route 53 ホストゾーン + DNS レコード管理

## 概要

Route 53 でホストゾーンを作成し、各種 DNS レコードとヘルスチェックを設定する構築型問題です。

## 対象サービス

- Amazon Route 53

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ホストゾーン | パブリックホストゾーン作成 | 25 点 |
| Alias A レコード | ALB を指す Alias レコード | 25 点 |
| CNAME レコード | API サブドメインの CNAME | 25 点 |
| ヘルスチェック | HTTP ヘルスチェック | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `ListHostedZones` でホストゾーンの存在を確認
2. `ListResourceRecordSets` で A レコード（Alias）を確認
3. `ListResourceRecordSets` で CNAME レコードを確認
4. `GetHealthCheck` でヘルスチェック設定を確認

## 参考ドキュメント

- [Route 53 ホストゾーン](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-working-with.html)
- [Route 53 Alias レコード](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html)
