# TenkaCloud Development Plan

このファイルは、TenkaCloud の開発プロセス、意思決定、実装内容、振り返りを記録するためのドキュメントです。

## 実行計画 (Exec Plans)

### マルチテナントSaaSアーキテクチャ基盤構築 - 2025-01-08

**目的 (Objective)**:
- AWS SaaS Factory EKS Reference Architecture をベースにしたマルチテナント基盤の設計
- Control Plane / Application Plane の 2 層アーキテクチャ実装
- 3 層 UI 構造（Control Plane UI / Admin UI / Participant UI）の設計

**制約 (Guardrails)**:
- テナント間のデータ分離を厳格に実施
- すべての実装はテストファースト（カバレッジ 100％）
- ユビキタス言語を使用した命名規則の徹底

**タスク (TODOs)**:
- [x] AWS SaaS Factory EKS Reference Architecture の調査
- [x] マルチテナントアーキテクチャ設計書作成
- [x] バックエンドディレクトリ構造作成
- [x] インフラストラクチャディレクトリ構造作成
- [x] アーキテクチャドキュメント作成（multi-tenant-design.md、directory-structure.md）
- [x] CLAUDE.md に開発プレイブック追加
- [x] Plan.md 初期化
- [x] GitHub Issue テンプレート作成
- [ ] バックログを GitHub Issue に書き起こし

**検証手順 (Validation)**:
- ドキュメントの網羅性確認
- ディレクトリ構造の妥当性確認
- アーキテクチャ設計のレビュー

**未解決の質問 (Open Questions)**:
- LocalStack vs kind（ローカル開発環境）
- テストフレームワークの選択（Jest vs Vitest）

**進捗ログ (Progress Log)**:
- [2025-01-08 14:00]AWS SaaS Factory EKS Reference Architecture 調査完了
- [2025-01-08 15:30]Control Plane/Application Plane 設計完了
- [2025-01-08 16:00]3 層 UI 構造設計追加（Control Plane UI/Admin UI/Participant UI）
- [2025-01-08 16:30]Deployment Management Service 設計追加
- [2025-01-08 17:00]ディレクトリ構造作成完了
- [2025-01-08 17:30]アーキテクチャドキュメント作成完了
- [2025-01-08 18:00]CLAUDE.md に開発プレイブック追加
- [2025-01-08 18:15]Plan.md 初期化
- [2025-01-08 18:20]GitHub Issue テンプレート作成完了

**振り返り (Retrospective)**:

##### 問題 (Problem)
PR を作成した後、CI の状態確認を忘れて push がタイムアウトした。

##### 根本原因 (Root Cause)
- PR ワークフローに「CI の状態確認」が明示的に含まれていなかった
- タイムアウト時の対応手順が不明確だった

##### 予防策 (Prevention)
- CLAUDE.md の「自律開発フロー」に「CI 検証」ステップを追加（CRITICAL）
- CI ステータス確認コマンドを明示（`gh pr checks`）
- 失敗時の修正フローを文書化

→ 対応完了

---

### テナント管理サービス MVP - 2025-11-09

**目的 (Objective)**:
- Control Plane でテナント情報と状態遷移を一元管理する REST API を提供する
- テナント状態変更の監査・イベント連携を可能にし、Application Plane への伝搬を保証する
- `backend/services/control-plane/tenant-management` に 100% テストカバレッジの運用可能なサービススタックを確立する

**制約 (Guardrails)**:
- DynamoDB の単一テーブル設計を維持し、テナント分離キーを `TENANT#<id>` 形式で統一する
- Fastify + TypeScript + Bun/Vitest 構成で 100% カバレッジ達成を必須とする
- shared telemetry モジュール経由で監査ログ・メトリクスを出力し、PII は暗号化/マスキングする
- CLAUDE.md の自律開発フローに従い、CI Green になるまでマージ不可

**関連 Issue**:
- #27 Control Plane Tenant Management Service MVP

**タスク (TODOs)**:
- [ ] テナントドメインモデルと DynamoDB パーティション/ソートキーの定義を docs/architecture に追記 (#27)
- [ ] OpenAPI 仕様 (Create/List/Get/Update/Suspend/Resume/Delete) を `backend/services/control-plane/tenant-management/openapi.yaml` に作成 (#27)
- [ ] Fastify サービスのブートストラップ（config, validation, logging, tracing, error handling）を整備 (#27)
- [ ] Repository/UseCase 層で CRUD + 状態遷移ロジックと監査ログ永続化を実装 (#27)
- [ ] EventBridge 互換イベントパブリッシャを shared 層に実装し、状態遷移イベントを publish (#27)
- [ ] Bun/Vitest ベースのユニット & コントラクトテストで 100% カバレッジを達成 (#27)
- [ ] Runbook / README を更新し、ローカル実行・デプロイ手順を記載 (#27)
- [ ] Control Plane namespace 向けの Kubernetes manifest / Helm values を下書きし、デプロイ手順をまとめる (#27)

**検証手順 (Validation)**:
- `bun run lint`, `bun run typecheck`, `bun run test:coverage`, `bun run lint_text` がすべて成功すること
- `bun run build` でテナント管理サービスがビルド可能であること
- DynamoDB Local + EventBridge エミュレータを用いた CRUD/状態遷移/イベント publish の統合テストが通過すること
- OpenAPI 仕様に対するモックテスト (`scripts/dev/tenant-management.sh` 等) が成功し、CI で自動検証されること

**未解決の質問 (Open Questions)**:
- Registration Service とテーブルを共有するか、Control Plane 専用テーブルを分離するか
- イベントバスは LocalStack を採用するか、軽量な in-memory pub/sub から着手するか
- 監査ログの保存先を DynamoDB で兼用するか、OpenSearch/CloudWatch Logs に分離するか

**進捗ログ (Progress Log)**:
- [2025-11-09 10:20] 実装プラン作成および Issue #27 を起票

---

### Control Plane 基盤構築 (Terraform + Keycloak) - 2025-11-10

**目的 (Objective)**:
- TenkaCloud のコントロールプレーン（管理基盤）を **マルチクラウド対応** で構築する
- reference/eks の SaaS Factory EKS Reference Architecture のコンセプトを参考にしつつ、**ベンダーロックインを回避**
- マルチテナント SaaS の基盤となる認証・認可、テナント管理、イベント管理機能を実装する

**背景 (Background)**:
- TenkaCloud はマルチクラウド対応が必須要件（AWS/GCP/Azure/OCI/LocalStack）
- reference/eks は AWS 固有の実装だが、アーキテクチャパターンは参考にする
- コントロールプレーンの責務：
  - テナント管理（登録、プロビジョニング、削除）
  - 認証・認可（Keycloak ベース）
  - イベント管理（クラウドネイティブイベントバス）
  - システム管理者機能

**技術スタック（クラウドアグノスティック）**:
- **IaC**: Terraform（マルチクラウド対応）
- **認証**: Keycloak（OSS、OIDC/SAML 対応）
- **コンテナオーケストレーション**: Kubernetes (EKS/GKE/AKS)
- **イベントバス**: NATS / Apache Kafka（クラウドネイティブ）
- **データベース**: PostgreSQL（Keycloak 用）+ DynamoDB/Firestore/CosmosDB（テナントデータ）
- **サービスメッシュ**: Istio / Linkerd（テナント分離）

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う
- テスト駆動開発（TDD）- カバレッジ 100%
- TypeScript strict mode
- セキュリティベストプラクティスの遵守（OWASP Top 10）

**タスク (TODOs)**:
- [x] reference/eks の Control Plane アーキテクチャ調査
- [x] マルチクラウド対応の技術スタック選定（Terraform + Keycloak）
- [ ] プロジェクト構造の作成（infrastructure/terraform/control-plane/）
- [ ] Terraform モジュール構成の設計
- [ ] Keycloak デプロイメント（Kubernetes）
  - [ ] Keycloak Helm Chart の設定
  - [ ] PostgreSQL データベースのプロビジョニング
  - [ ] Realm/Client/Role の初期設定
  - [ ] OIDC プロバイダー設定
- [ ] Kubernetes リソースの定義
  - [ ] Namespace 作成（control-plane）
  - [ ] ServiceAccount と RBAC 設定
  - [ ] Ingress 設定（Keycloak 管理コンソール）
- [ ] イベントバス（NATS/Kafka）のデプロイ
- [ ] テナント管理サービスの実装（TypeScript/Go）
  - [ ] テナント CRUD API
  - [ ] Keycloak Realm 自動作成
  - [ ] イベントパブリッシュ
- [ ] Terraform モジュールのテスト（Terratest）
- [ ] ドキュメント作成

**ディレクトリ構造**:
```
infrastructure/
└── terraform/
    ├── modules/
    │   ├── keycloak/              # Keycloak モジュール
    │   │   ├── main.tf
    │   │   ├── variables.tf
    │   │   ├── outputs.tf
    │   │   └── helm-values.yaml   # Keycloak Helm values
    │   ├── event-bus/             # NATS/Kafka モジュール
    │   │   ├── main.tf
    │   │   └── variables.tf
    │   ├── database/              # PostgreSQL モジュール
    │   │   ├── main.tf
    │   │   └── variables.tf
    │   └── kubernetes-base/       # Kubernetes 基盤
    │       ├── main.tf
    │       └── namespaces.tf
    ├── environments/
    │   ├── dev/
    │   │   ├── main.tf
    │   │   ├── variables.tf
    │   │   └── terraform.tfvars
    │   ├── staging/
    │   └── prod/
    └── control-plane/             # Control Plane メインディレクトリ
        ├── main.tf
        ├── variables.tf
        ├── outputs.tf
        ├── providers.tf           # マルチクラウドプロバイダー
        └── backend.tf

backend/
└── services/
    └── control-plane/
        └── tenant-management/     # テナント管理サービス
            ├── src/
            │   ├── api/           # REST API
            │   ├── keycloak/      # Keycloak クライアント
            │   ├── events/        # イベントパブリッシュ
            │   └── database/      # DB アクセス
            ├── test/
            ├── Dockerfile
            └── package.json
```

**検証手順 (Validation)**:
1. Terraform の構文チェックが成功すること
   ```bash
   cd infrastructure/terraform/control-plane
   terraform fmt -check
   terraform validate
   ```

2. Terraform モジュールのテスト（Terratest）が通過すること
   ```bash
   cd infrastructure/terraform/modules/keycloak
   go test -v
   ```

3. Keycloak が正常にデプロイされること（kind/LocalStack）
   ```bash
   # kind クラスターで検証
   terraform plan
   terraform apply
   kubectl get pods -n control-plane
   ```

4. テナント管理サービスのテストが通過すること（カバレッジ 100%）
   ```bash
   cd backend/services/control-plane/tenant-management
   bun run test
   bun run test:coverage
   ```

5. Keycloak との統合テストが成功すること
   ```bash
   # Keycloak 起動後、OIDC トークン取得テスト
   bun run test:integration
   ```

**未解決の質問 (Open Questions)**:
- [ ] ローカル開発環境: kind vs minikube vs k3s
- [ ] イベントバス: NATS vs Apache Kafka（どちらを選択するか）
- [ ] テナント tier の定義（Free, Pro, Enterprise など）
- [ ] Keycloak の Realm 設計（マスター Realm + テナント別 Realm？）
- [ ] データベース選択: PostgreSQL のマネージドサービス vs セルフホスト
- [ ] マルチクラウドのデータストア抽象化レイヤー設計
- [ ] ドメイン名の決定（*.tenkacloud.io など）

**進捗ログ (Progress Log)**:
- [2025-11-10 23:30] reference/eks/lib/control-plane-stack.ts を確認
- [2025-11-10 23:35] reference/eks/GUIDE.md を確認
- [2025-11-10 23:40] Plan.md に AWS CDK ベースの実行計画を追加
- [2025-11-10 23:50] ユーザーフィードバックでマルチクラウド対応に方針変更
- [2025-11-10 23:55] Terraform + Keycloak ベースのアーキテクチャに設計変更完了

**振り返り (Retrospective)**:
*（実装後に記入）*

---

## 次の実行計画テンプレート

以下のテンプレートを使用して、新しい機能開発の実行計画を作成してください：

```markdown
### [機能名] - [YYYY-MM-DD]

**目的 (Objective)**:
- 何を達成するか

**制約 (Guardrails)**:
- 守るべきルール・制約

**タスク (TODOs)**:
- [ ] タスク 1
- [ ] タスク 2

**検証手順 (Validation)**:
- テスト実行方法
- 確認すべき項目

**未解決の質問 (Open Questions)**:
- 調査が必要な項目

**進捗ログ (Progress Log)**:
- [YYYY-MM-DD HH:MM] 実施内容と結果

**振り返り (Retrospective)**:
（問題が発生した場合のみ記入）

##### 問題 (Problem)
何が起きたか（具体的に）

##### 根本原因 (Root Cause)
なぜ起きたか（技術的・プロセス的）

##### 予防策 (Prevention)
- CLAUDE.md に追加すべきルール
- 自動化できるチェック
- ドキュメント更新
```
