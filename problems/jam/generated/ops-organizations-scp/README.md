# Organizations SCP によるアカウントガバナンス

## 概要

AWS Organizations と SCP を使い、マルチアカウント環境のガバナンスガードレールを構築する構築型問題です。

## 対象サービス

- AWS Organizations

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Organization | AWS Organization の作成 | 15 点 |
| OU | 開発用/本番用 OU | 20 点 |
| SCP リージョン制限 | 許可リージョン制限 | 25 点 |
| SCP サービス制限 | 高額サービス制限 | 25 点 |
| タグポリシー | 必須タグ強制 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeOrganization` で Organization が存在するか
2. `ListOrganizationalUnitsForParent` で OU が存在するか
3. `ListPolicies` でリージョン制限 SCP が存在するか
4. `ListPolicies` でサービス制限 SCP が存在するか
5. `ListPolicies` でタグポリシーが存在するか

## 参考ドキュメント

- [AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_introduction.html)
- [SCP](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
