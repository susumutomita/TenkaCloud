# フル CI/CD パイプライン

## 概要

CodePipeline + CodeBuild + CodeDeploy で Source → Build → Staging → Approval → Production の完全自動化パイプラインを構築する Expert レベルの構築型問題です。

## 対象サービス

- AWS CodePipeline, CodeBuild, CodeDeploy
- Elastic Load Balancing (ALB), EC2 Auto Scaling
- Amazon S3, SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CodePipeline | 4 ステージパイプライン | 20 点 |
| CodeBuild | ビルド/テストプロジェクト | 15 点 |
| CodeDeploy | Staging + Production DG | 20 点 |
| 承認ゲート | 手動承認ステージ | 15 点 |
| ALB + ASG | 本番環境 | 15 点 |
| SNS 通知 | パイプライン + 承認通知 | 15 点 |

## 参考ドキュメント

- [CodePipeline](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [CodeDeploy Blue/Green](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployments-create-console.html)
