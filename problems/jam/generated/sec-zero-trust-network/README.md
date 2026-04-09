# ゼロトラストネットワーク設計

## 概要

VPC エンドポイント、Network Firewall、PrivateLink を使ったゼロトラストネットワークを構築する構築型問題です。

## 対象サービス

- Amazon VPC Endpoints
- AWS Network Firewall
- AWS PrivateLink
- VPC Flow Logs

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| VPC エンドポイント | 4 サービス分 | 20 点 |
| エンドポイントポリシー | リソース制限 | 20 点 |
| Network Firewall | ドメインフィルタ | 25 点 |
| SG 設計 | エンドポイント通信のみ | 15 点 |
| PrivateLink | サービス間通信 | 10 点 |
| フローログ | 全フロー記録 | 10 点 |

## 参考ドキュメント

- [VPC エンドポイント](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html)
- [Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html)
