# EBS ボリュームタイプとスナップショットの最適化

## 概要

EBS ボリュームを gp2 から gp3 に最適化し、コストを削減する構築型問題です。

## 対象サービス

- Amazon EBS

## コスト最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| gp3 ボリュームタイプ | gp3 に設定 | 30 点 |
| IOPS 設定 | 3000 IOPS を明示設定 | 25 点 |
| スループット設定 | 125 MB/s を明示設定 | 25 点 |
| 暗号化有効 | ボリューム暗号化を有効化 | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `DescribeVolumes` で VolumeType が gp3 であるか
2. `DescribeVolumes` で Iops が 3000 であるか
3. `DescribeVolumes` で Throughput が 125 であるか
4. `DescribeVolumes` で Encrypted が true であるか

## 参考ドキュメント

- [EBS ボリュームタイプ](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [gp2 から gp3 への移行](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html)
