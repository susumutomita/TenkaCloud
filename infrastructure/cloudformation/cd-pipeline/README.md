# TenkaCloud CD Pipeline

CodePipeline V2ベースのCDパイプライン。GitHub上の `main` の変更を手動承認後にビルド・デプロイする。
ビルドステージは `scripts/install.sh` をそのままCodeBuild上で再実行し、ローカル `make deploy` と同じdeployロジックを共有する。

## アーキテクチャ

```text
GitHub Repository (maishu-kobo/TenkaCloud)
       │
       ▼
┌─────────────────────┐
│  Source Stage       │  GitHub CodeStar Connection (DetectChanges=false)
│                     │  → 手動 / start-pipeline-execution で起動
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  Manual Approval    │  CodePipeline UI で承認
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  Build Stage        │  CodeBuild (privileged)
│  buildspec.yml      │  └─ scripts/install.sh "$SYSTEM_ADMIN_EMAIL"
│                     │     ├ Phase 1: backend stacks (ControlPlane / Bootstrap / Tenant-pooled / Pipeline)
│                     │     ├ Phase 2: admin-console build + AdminConsoleHostingStack
│                     │     └ Phase 3: ControlPlaneStack 再 deploy (CloudFront URL を CORS/callback に追加)
└─────────────────────┘
```

## 前提条件

### 1. GitHub CodeStar Connection の作成

CloudFormation投入前にAWS Consoleで手動作成する。

1. AWS Console → Developer Tools → Connections
2. "Create connection" → GitHubを選択
3. Connection名を入力 (例: `TenkaCloud-github`)
4. "Connect to GitHub" でGitHub認証を完了
5. **Status が `Available` になることを確認**
6. Connection ARNを控える

### 2. Broker Entra credentials を SSM に投入

TenkaCloudはBroker Entra credentialsをSSM SecureStringで持つ (Secrets Managerは使わない)。
パイプラインはSSMの既存値を読むので、ローカルで1度だけbootstrapする必要がある。

```bash
make bootstrap-broker-entra
```

これで `/TenkaCloud/broker-entra/profiles/default/graph-credentials` が作成される。
非default profileを使う場合は `BROKER_ENTRA_PROFILE_ID` をCFnパラメータで指定する。

> CDK Bootstrap (`cdk bootstrap`) はパイプライン側の `scripts/install.sh` が自動で叩くので、事前準備は不要。

## デプロイ

### パラメータ

| パラメータ                | 必須 | 説明                                                                |
| ------------------------- | ---- | ------------------------------------------------------------------- |
| `Environment`             | -    | `development` / `staging` / `production` (default: development)     |
| `GitHubConnectionArn`     | ○    | 手動作成した GitHub Connection の ARN                               |
| `GitHubRepositoryId`      | -    | `owner/repo` 形式 (default: `maishu-kobo/TenkaCloud`)                |
| `SourceBranchName`        | -    | 監視ブランチ (default: `main`)                                      |
| `SystemAdminEmail`        | ○    | Cognito 初回招待メール送信先                                        |
| `BrokerEntraProfileId`    | -    | Broker Entra profile ID (default: `default`)                        |
| `PipelineName`            | -    | カスタムパイプライン名 (省略時: `TenkaCloud-{Environment}`)          |
| `CodeBuildProjectName`    | -    | カスタム CodeBuild 名 (省略時: `TenkaCloud-{Environment}`)           |
| `CodeBuildTimeoutMinutes` | -    | CodeBuild タイムアウト分 (default: 120 / max: 480)                  |

### デプロイ手順 (AWS Console)

パイプラインスタックは初回1回だけの仕込みなのでGUIから流す。

1. AWS Console → CloudFormation →「スタックの作成」→「新しいリソースを使用 (標準)」
2. 「テンプレートファイルのアップロード」で `infrastructure/cloudformation/cd-pipeline/cd-pipeline.yaml` を選択
3. スタック名: `TenkaCloud-cd-pipeline-development` (またはenvに合わせて)
4. パラメータを入力:
    - `Environment`: `development` / `staging` / `production`
    - `GitHubConnectionArn`: 前提条件1で控えたARN
    - `SystemAdminEmail`: Cognito招待メール送信先
    - その他はdefaultのままでOK
5. 「IAMリソースが作成されることを承認します」にチェック (`CAPABILITY_NAMED_IAM`)
6. 「送信」→ スタック作成完了まで2-3分

パラメータの後追い変更も同Consoleから「スタックの更新」で可能。Infrastructure as Codeの追跡性を保ちたいのでCodeBuildのenvを直接編集するのは非推奨。

## パイプライン実行

### 手動実行

```bash
aws codepipeline start-pipeline-execution \
  --name TenkaCloud-development \
  --region ap-northeast-1
```

### 承認

1. AWS Console → CodePipeline → `TenkaCloud-{env}` を開く
2. `manual-approve` ステージの "Review" → コメントを入れてApprove
3. Buildステージで `scripts/install.sh` が走る (進捗はCodeBuildログで追える)

### 通知

`TenkaCloud-{env}-pipeline-notification` SNS Topicへ通知が流れる。pipeline実行イベント (開始 / 成功 / 失敗 / キャンセル) とmanual approvalイベント (要求 / 承認 / 却下) を含む。

email subscriptionまたはAWS Chatbot経由Slackに手動で接続する。

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:ap-northeast-1:123456789012:TenkaCloud-development-pipeline-notification \
  --protocol email \
  --notification-endpoint ops@example.com
```

## 作成されるリソース

| 種別             | 名前                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| S3 Bucket        | `TenkaCloud-{env}-pipeline-artifacts-{accountId}` (30 日 TTL)                                |
| CodeBuild        | `TenkaCloud-{env}` (Amazon Linux 2023 / privileged)                                          |
| CodePipeline     | `TenkaCloud-{env}` (V2 / QUEUED)                                                             |
| IAM Roles        | `TenkaCloud-{env}-codebuild-role`, `TenkaCloud-{env}-pipeline-role`                           |
| CloudWatch Logs  | `/aws/codebuild/TenkaCloud-{env}`                                                            |
| SNS Topic        | `TenkaCloud-{env}-pipeline-notification`                                                     |

## 関連ファイル

- `cd-pipeline.yaml` … CloudFormationテンプレート (このディレクトリ)
- `/buildspec.yml` … CodeBuild入口 (リポジトリルート)
- `/scripts/install.sh` … 3-phase deploy本体 (ローカル `make deploy` と共有)
- `/infrastructure/environments/{env}/.env` … local用 (CodeBuildはCFnパラメータからenvを引くので不要)
