# VPC + サブネット設計

## 概要

VPC を新規作成し、パブリック/プライベートサブネットを 2 AZ に配置するネットワーク基盤の構築型問題です。

## 対象サービス

- Amazon VPC
- Internet Gateway
- NAT Gateway
- Route Table

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| VPC 設計 | 適切な CIDR、DNS サポート有効 | 25 点 |
| パブリックサブネット + IGW | 2 AZ、Internet Gateway ルート | 25 点 |
| プライベートサブネット + NAT | 2 AZ、NAT Gateway ルート | 25 点 |
| ルートテーブル設定 | 適切な関連付け | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribeVpcs` で VPC の CIDR、DNS 設定を確認
2. `DescribeSubnets` でパブリック/プライベートサブネットが 2 AZ に存在するか
3. `DescribeInternetGateways` で IGW が VPC にアタッチされているか
4. `DescribeNatGateways` で NAT Gateway がパブリックサブネットに配置されているか
5. `DescribeRouteTables` でルートテーブルが適切に設定されているか

## 参考ドキュメント

- [Amazon VPC ユーザーガイド](https://docs.aws.amazon.com/vpc/latest/userguide/)
- [VPC のサブネット](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html)
- [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
