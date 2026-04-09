# CodeDeploy Blue/Green デプロイメント構築

## 概要

CodeDeploy の Blue/Green デプロイメントを構築し、ゼロダウンタイムリリースと自動ロールバックを実現する構築型問題です。

## 対象サービス

- AWS CodeDeploy
- Elastic Load Balancing (ALB)
- Amazon EC2 Auto Scaling

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CodeDeploy アプリケーション | Server プラットフォーム | 15 点 |
| デプロイグループ | Blue/Green デプロイグループ | 30 点 |
| ALB + ターゲットグループ | 2 つの TG | 20 点 |
| Auto Scaling グループ | Blue 環境 ASG | 15 点 |
| ロールバック設定 | 自動ロールバック | 20 点 |

## 参考ドキュメント

- [CodeDeploy Blue/Green](https://docs.aws.amazon.com/codedeploy/latest/userguide/welcome.html)
