# IAM 最小権限設計

## 概要

最小権限の原則に基づいた IAM 設計と MFA 強制の仕組みを構築する問題です。

## 対象サービス

- AWS IAM

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| アプリケーションロール | S3 特定バケットのみ許可 | 25 点 |
| ポリシー条件 | 暗号化強制 | 25 点 |
| MFA 必須管理者ロール | AssumeRole に MFA 条件 | 25 点 |
| MFA 強制ポリシー | 未設定ユーザーの操作拒否 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetRole` / `GetRolePolicy` でアプリケーションロールのポリシーがリソースレベルで制限されているか
2. `GetRolePolicy` で Deny ステートメントに暗号化条件が含まれているか
3. `GetRole` で管理者ロールの AssumeRolePolicyDocument に MFA 条件があるか
4. `GetGroupPolicy` で MFA 強制ポリシーが `NotAction` + `BoolIfExists` で構成されているか

## 設計のポイント

- **リソースレベル権限**: `Resource: "*"` ではなく、特定の S3 バケット ARN を指定する
- **条件付きポリシー**: `Condition` で暗号化、リージョン、タグなどの条件を付与する
- **MFA 強制**: `NotAction` と `BoolIfExists` の組み合わせで、MFA セットアップのみを許可する
- **Deny 優先**: Allow で広く許可するのではなく、Deny で危険な操作を明示的にブロックする

## 参考ドキュメント

- [IAM のベストプラクティス](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [IAM ポリシーの条件](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition.html)
- [MFA を使用した API アクセスの保護](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html)
