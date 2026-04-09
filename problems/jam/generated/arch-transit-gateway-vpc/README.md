# Transit Gateway マルチ VPC 接続

## 概要

Transit Gateway で 3 つの VPC をハブ&スポーク型で接続し、ネットワーク分離を実装する構築型問題です。

## 対象サービス

- AWS Transit Gateway
- Amazon VPC

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| Transit Gateway | 作成 + DNS サポート | 15 点 |
| VPC アタッチメント | 3 VPC アタッチ | 25 点 |
| ルートテーブル + 分離 | 本番/開発の分離 | 30 点 |
| VPC ルーティング | TGW へのルート追加 | 30 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeTransitGateways` で TGW の設定を確認
2. `DescribeTransitGatewayAttachments` でアタッチメントを確認
3. `GetTransitGatewayRouteTableAssociations` と `Propagations` でルーティングを確認
4. `DescribeRouteTables` で VPC ルートテーブルを確認

## 参考ドキュメント

- [Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html)
- [Transit Gateway ルートテーブル](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html)
