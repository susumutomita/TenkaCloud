# CodePipeline CI/CD パイプライン構築

## 概要

CodePipeline と CodeBuild を使い、ソースコード変更の自動ビルド・テスト・デプロイパイプラインを構築する構築型問題です。

## 対象サービス

- AWS CodePipeline
- AWS CodeBuild
- Amazon S3
- Amazon SNS

## 運用要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ソースステージ | S3 ソースのパイプラインステージ | 20 点 |
| ビルドステージ | CodeBuild ビルドステージ | 25 点 |
| アーティファクトストア | アーティファクト S3 バケット | 15 点 |
| IAM ロール | CodePipeline + CodeBuild IAM ロール | 25 点 |
| SNS 通知 | パイプライン実行結果通知 | 15 点 |

## 採点方法

Scoring Service が参加者の AWS アカウント（または LocalStack）に対して AWS SDK で以下を検証します。

1. `GetPipeline` でパイプラインが存在しソースステージが S3 であるか
2. `BatchGetProjects` で CodeBuild プロジェクトが存在するか
3. `ListBuckets` でアーティファクト S3 バケットが存在するか
4. `GetRole` で CodePipeline と CodeBuild の IAM ロールが存在するか
5. `ListNotificationRules` で通知ルールが存在するか

## 参考ドキュメント

- [CodePipeline](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [CodeBuild](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
