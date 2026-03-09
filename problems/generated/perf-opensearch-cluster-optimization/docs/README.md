# OpenSearch クラスターのパフォーマンス最適化

## 概要

OpenSearch クラスターのノード構成、EBS、マルチ AZ、暗号化を最適化する構築型問題です。

## 対象サービス

- Amazon OpenSearch Service

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| データノード | m6g.large 2 ノード | 25 点 |
| EBS 最適化 | gp3 100 GB、3000 IOPS | 25 点 |
| Zone Awareness | マルチ AZ 有効 | 25 点 |
| 暗号化 | ノード間 + 保存時暗号化 | 25 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeDomain` で InstanceType が m6g.large.search、InstanceCount が 2 であるか
2. `DescribeDomain` で EBS が gp3、100 GB、3000 IOPS であるか
3. `DescribeDomain` で ZoneAwarenessEnabled が true であるか
4. `DescribeDomain` で NodeToNodeEncryption と EncryptionAtRest が有効であるか

## 参考ドキュメント

- [OpenSearch クラスターサイジング](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/sizing-domains.html)
- [OpenSearch EBS ボリューム](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-dedicatedmasternodes.html)
