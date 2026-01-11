# AWS Problem Deployment from Admin Console

## 概要

管理画面から問題を AWS にデプロイできる機能を実装する。

## 現状分析

### 既存インフラ (Ready)

- `DeploymentTemplate` モデル: 問題ごとの CloudFormation テンプレート定義
- `DeploymentJob` モデル: デプロイジョブ追跡
- `providers/aws/index.ts`: CloudFormation スタック操作
- `problems/deployer.ts`: ProblemDeployer オーケストレーター

### 不足機能

1. Admin API: 問題デプロイをトリガーするエンドポイント
2. Admin UI: デプロイボタン、進捗表示、履歴閲覧

## 実装計画

### Phase 1: Backend API（同期デプロイ MVP）✅ 完了

#### 1.1 実装済みエンドポイント

```text
POST   /admin/problems/:problemId/deploy                    - デプロイ開始
GET    /admin/problems/:problemId/deployments/:stackName/status - ステータス確認
DELETE /admin/problems/:problemId/deployments/:stackName    - スタック削除
GET    /admin/aws/regions                                   - リージョン一覧
```

#### 1.2 現在の制限事項

- **同期デプロイ**: HTTP リクエスト内で CloudFormation 完了まで待機（タイムアウトリスクあり）
- **永続化なし**: DeploymentJob モデル未使用（履歴・リトライ不可）
- **Mock 実装**: AWS SDK は開発用 Mock（本番では実装が必要）

### Phase 2: 非同期デプロイ（次回以降）

- DeploymentJobRepository 実装
- ジョブキュー（SQS/Bull）で非同期実行
- WebSocket/SSE でリアルタイム進捗通知
- リトライ・エラーリカバリー

### Phase 3: Frontend UI（次回以降）

#### 3.1 問題詳細ページにデプロイセクション追加

- デプロイボタン
- プロバイダー/リージョン選択
- パラメータ入力

#### 3.2 デプロイ進捗・履歴表示

- ステータスバッジ（Pending/Running/Completed/Failed）
- ログ/出力表示
- 再試行/キャンセルボタン

## 技術的考慮事項

### デプロイフロー（Phase 2 目標）

1. 管理者がデプロイをトリガー
2. DeploymentJob レコード作成 (status: PENDING)
3. 非同期で CloudFormation スタック作成
4. ステータス更新 (RUNNING → COMPLETED/FAILED)
5. 管理者がポーリングで進捗確認

### セキュリティ

- 管理者認証必須
- AWS クレデンシャルは環境変数で管理
- CloudFormation テンプレートのバリデーション
- システムタグはユーザー上書き不可

## 完了ステップ

1. [x] 既存コードベース調査
2. [x] Admin API エンドポイント追加（同期 MVP）
3. [x] テスト作成
4. [x] make before-commit 実行
5. [ ] DeploymentJobRepository 実装（Phase 2）
6. [ ] 非同期デプロイ実装（Phase 2）
