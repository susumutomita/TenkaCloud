# KMS キー階層 + マルチリージョンキー設計

## 概要

データ分類に基づく 4 レベルの KMS キー階層を設計し、マルチリージョンキー、暗号化コンテキスト強制を実装する構築型問題です。

## 対象サービス

- AWS KMS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| キー階層 | 4 レベル CMK | 20 点 |
| マルチリージョンキー | Restricted キー | 15 点 |
| キーポリシー + 職責分離 | レベル別アクセス権限 | 25 点 |
| KMS Grants | サービス間キー利用 | 15 点 |
| 自動ローテーション | 全キー有効 | 10 点 |
| 暗号化コンテキスト | 必須条件 | 15 点 |

## 参考ドキュメント

- [KMS マルチリージョンキー](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)
- [KMS 暗号化コンテキスト](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#encrypt_context)
