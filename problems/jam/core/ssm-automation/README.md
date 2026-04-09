# Systems Manager による運用自動化の構築

## 概要

Systems Manager を中心とした運用自動化基盤を構築する構築型問題です。パッチ管理、インベントリ収集、メンテナンスウィンドウを組み合わせた包括的な運用管理を実現します。

## 対象サービス

- AWS Systems Manager
- AWS IAM
- Amazon SNS
- Amazon EC2

## 運用自動化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| パッチベースライン | カスタムベースライン + 承認ルール | 20 点 |
| メンテナンスウィンドウ | 定期パッチ適用ウィンドウ + タスク | 25 点 |
| インベントリ収集 | SSM インベントリアソシエーション | 20 点 |
| IAM ロール | EC2 用 SSM 対応 IAM ロール | 20 点 |
| SNS 通知 | メンテナンス実行結果の通知 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `DescribePatchBaselines` / `GetPatchBaseline` でカスタムベースラインが承認ルール付きで作成されているか
2. `DescribeMaintenanceWindows` / `DescribeMaintenanceWindowTasks` でウィンドウとパッチ適用タスクが登録されているか
3. `ListAssociations` / `DescribeAssociation` で AWS-GatherSoftwareInventory のアソシエーションが存在するか
4. `GetInstanceProfile` / `GetRole` で AmazonSSMManagedInstanceCore ポリシー付きのロールが存在するか
5. メンテナンスウィンドウタスクの NotificationConfig に SNS トピックが設定されているか

## 参考ドキュメント

- [AWS Systems Manager Patch Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-patch.html)
- [メンテナンスウィンドウ](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-maintenance.html)
- [SSM インベントリ](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-inventory.html)
- [SSM に必要な IAM 権限](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html)
