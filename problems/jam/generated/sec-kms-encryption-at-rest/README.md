# KMS カスタマーマネージドキー + 暗号化設計

## 概要

KMS カスタマーマネージドキーを作成し、複数サービスに保存時暗号化を適用する構築型問題です。

## 対象サービス

- AWS KMS
- Amazon S3
- Amazon DynamoDB

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CMK + ローテーション | 自動ローテーション有効 | 25 点 |
| キーポリシー | 管理者/利用者分離 | 25 点 |
| エイリアス | 用途別エイリアス | 10 点 |
| クロスサービス暗号化 | 4 サービスに CMK 適用 | 40 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeKey` でキーの設定とローテーションを確認
2. `GetKeyPolicy` でキーポリシーの内容を確認
3. `ListAliases` でエイリアスを確認
4. 各サービスの暗号化設定で CMK が使われていることを確認

## 参考ドキュメント

- [KMS キーポリシー](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)
- [KMS キーローテーション](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
