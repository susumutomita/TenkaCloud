# EKS クラスター + マネージドノードグループ構成

## 概要

EKS クラスターをマネージドノードグループで構築し、IAM ロールとログ設定を行う構築型問題です。

## 対象サービス

- Amazon EKS
- IAM
- CloudWatch Logs

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| EKS クラスター | クラスター作成 + ロール | 25 点 |
| ノードグループ | 最小 2 / 最大 4 | 25 点 |
| IAM ロール | クラスター + ノードロール | 20 点 |
| ネットワーク | プライベートサブネット配置 | 15 点 |
| ログ | API + 認証ログ | 15 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeCluster` でクラスターの設定を確認
2. `ListNodegroups` + `DescribeNodegroup` でノードグループ設定を確認
3. IAM ロールのポリシーアタッチメントを確認
4. ネットワーク設定とログ設定を確認

## 参考ドキュメント

- [Amazon EKS クラスター](https://docs.aws.amazon.com/eks/latest/userguide/clusters.html)
- [マネージドノードグループ](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
