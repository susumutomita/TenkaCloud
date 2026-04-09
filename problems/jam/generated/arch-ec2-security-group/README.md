# EC2 インスタンス + セキュリティグループ設計

## 概要

EC2 インスタンスをセキュリティグループで保護し、EBS 暗号化を設定する構築型問題です。

## 対象サービス

- Amazon EC2
- Security Group
- EBS

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| セキュリティグループ | HTTP 公開 + SSH 制限 | 30 点 |
| EC2 インスタンス | Launch Template + t3.micro | 25 点 |
| EBS 暗号化 | gp3 + 暗号化有効 | 25 点 |
| タグ設定 | Name + Environment タグ | 20 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeSecurityGroups` でインバウンドルールを確認
2. `DescribeInstances` でインスタンスタイプと Launch Template を確認
3. `DescribeVolumes` で暗号化状態と VolumeType を確認
4. 各リソースのタグを確認

## 参考ドキュメント

- [Amazon EC2 セキュリティグループ](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)
- [EBS ボリュームの暗号化](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EBSEncryption.html)
