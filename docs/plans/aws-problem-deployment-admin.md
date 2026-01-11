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

### Phase 1: Backend API (今回のスコープ)

#### 1.1 デプロイメント管理API追加

```
POST   /admin/problems/:problemId/deploy     - デプロイ開始
GET    /admin/problems/:problemId/deployments - デプロイ履歴
GET    /admin/deployments/:deploymentId      - デプロイ状態取得
DELETE /admin/deployments/:deploymentId      - デプロイキャンセル/削除
```

#### 1.2 必要なリポジトリ追加
- DeploymentJobRepository (CRUD)
- DeploymentTemplateRepository (CRUD)

### Phase 2: Frontend UI (次回以降)

#### 2.1 問題詳細ページにデプロイセクション追加
- デプロイボタン
- プロバイダー/リージョン選択
- パラメータ入力

#### 2.2 デプロイ進捗・履歴表示
- ステータスバッジ（Pending/Running/Completed/Failed）
- ログ/出力表示
- 再試行/キャンセルボタン

## 技術的考慮事項

### デプロイフロー
1. 管理者がデプロイをトリガー
2. DeploymentJob レコード作成 (status: PENDING)
3. 非同期で CloudFormation スタック作成
4. ステータス更新 (RUNNING → COMPLETED/FAILED)
5. 管理者がポーリングで進捗確認

### セキュリティ
- 管理者認証必須
- AWS クレデンシャルは環境変数で管理
- CloudFormation テンプレートのバリデーション

## 次のステップ

1. [x] 既存コードベース調査
2. [ ] DeploymentJobRepository 実装
3. [ ] Admin API エンドポイント追加
4. [ ] テスト作成
5. [ ] make before-commit 実行
