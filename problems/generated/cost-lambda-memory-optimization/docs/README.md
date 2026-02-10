# Lambda 関数のメモリとタイムアウト最適化

## 概要

Lambda 関数のメモリサイズ、アーキテクチャ、タイムアウトを最適化してコストを削減する構築型問題です。

## 対象サービス

- AWS Lambda

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| メモリサイズ最適化 | 128 MB に設定 | 30 点 |
| ARM アーキテクチャ | arm64（Graviton2）を使用 | 30 点 |
| タイムアウト設定 | 30 秒に設定 | 20 点 |
| コスト追跡環境変数 | COST_CENTER を設定 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetFunctionConfiguration` で MemorySize が 128 であるか
2. `GetFunctionConfiguration` で Architectures に arm64 が含まれるか
3. `GetFunctionConfiguration` で Timeout が 30 であるか
4. `GetFunctionConfiguration` で Environment.Variables に COST_CENTER が存在するか

## 参考ドキュメント

- [Lambda 関数のメモリ設定](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html)
- [Lambda Graviton2 サポート](https://docs.aws.amazon.com/lambda/latest/dg/foundation-arch.html)
