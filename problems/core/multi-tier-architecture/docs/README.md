# マルチ AZ マルチティア構成

## 概要

Web/App/DB の 3 層を分離し、マルチ AZ で高可用性を確保するエンタープライズ向けアーキテクチャの構築型問題です。

## 対象サービス

- Amazon VPC
- Elastic Load Balancing (ALB)
- Amazon RDS
- Security Groups

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| VPC + マルチ AZ サブネット | 2 AZ x 3 層の 6 サブネット | 20 点 |
| Web 層（外部 ALB） | Internet-facing ALB | 20 点 |
| App 層（内部 ALB） | Internal ALB、Web 層からのみ | 20 点 |
| DB 層（RDS Multi-AZ） | 分離サブネット、暗号化 | 20 点 |
| セキュリティグループ連鎖 | Web -> App -> DB | 20 点 |

## アーキテクチャ概要

```
Internet
    |
[External ALB] (Web 層 - パブリックサブネット)
    |
[Internal ALB] (App 層 - プライベートサブネット)
    |
[RDS Multi-AZ] (DB 層 - 分離サブネット)
```

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeSubnets` で 2 AZ x 3 層の 6 サブネットが存在するか
2. `DescribeLoadBalancers` で外部 ALB（internet-facing）と内部 ALB（internal）が存在するか
3. `DescribeDBInstances` で RDS が Multi-AZ かつストレージ暗号化有効か
4. `DescribeSecurityGroups` でセキュリティグループが連鎖しているか（Web SG -> App SG -> DB SG）
5. `DescribeRouteTables` で DB サブネットがインターネットへのルートを持たないか

## 参考ドキュメント

- [AWS Well-Architected フレームワーク](https://docs.aws.amazon.com/wellarchitected/latest/framework/)
- [VPC のセキュリティグループ](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
- [Amazon RDS Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)
