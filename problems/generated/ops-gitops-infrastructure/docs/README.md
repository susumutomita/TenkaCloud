# GitOps インフラストラクチャ管理パイプライン

## 概要

CodePipeline で CloudFormation テンプレートの検証、変更セット作成、承認、適用、ドリフト検出を自動化する GitOps パイプラインを構築する Expert レベルの構築型問題です。

## 対象サービス

- AWS CodePipeline, CodeBuild
- AWS CloudFormation
- AWS Lambda
- Amazon EventBridge
- Amazon S3, SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| CodePipeline | 5 ステージ GitOps パイプライン | 20 点 |
| CodeBuild 検証 | cfn-lint テンプレート検証 | 15 点 |
| CloudFormation | 変更セット作成/実行 | 25 点 |
| 承認ゲート | 手動承認 | 10 点 |
| Lambda ドリフト検出 | デプロイ後ドリフト検出 | 15 点 |
| EventBridge | パイプライン完了トリガー | 15 点 |

## 参考ドキュメント

- [CodePipeline + CloudFormation](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CloudFormation.html)
- [cfn-lint](https://github.com/aws-cloudformation/cfn-lint)
