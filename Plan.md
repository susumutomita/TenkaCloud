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

### Control Plane 管理コンソール UI (Next.js) - 2025-11-11

**目的 (Objective)**:
- Control Plane の管理コンソール UI を Next.js で構築する
- プラットフォーム管理者がテナント管理、ユーザー管理、システム監視を行えるダッシュボードを提供
- Keycloak による OIDC 認証を統合し、セキュアなアクセス制御を実現

**背景 (Background)**:
- Control Plane は TenkaCloud の管理基盤（テナント管理、認証、イベント管理）
- reference/eks には Admin App があり、テナント管理機能を提供している
- TenkaCloud の Control Plane UI は以下を担当：
  - **プラットフォーム管理者向け機能**
    - 全テナントの一覧・監視
    - テナントのライフサイクル管理（作成、停止、削除）
    - システムメトリクス・ログの可視化
    - Keycloak Realm 管理
    - 課金・使用量管理（将来）

**技術スタック**:
- **フレームワーク**: Next.js 14 (App Router)
- **言語**: TypeScript (strict mode)
- **スタイリング**: Tailwind CSS
- **UI コンポーネント**: shadcn/ui または Headless UI
- **状態管理**: Zustand または React Context
- **認証**: NextAuth.js + Keycloak OIDC
- **API クライアント**: OpenAPI Generator（テナント管理 API）
- **テスト**: Vitest + React Testing Library
- **E2E テスト**: Playwright

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う
- テスト駆動開発（TDD）- カバレッジ 100%
- TypeScript strict mode
- アクセシビリティ対応（WCAG 2.1 AA）
- レスポンシブデザイン（モバイルファースト）

**タスク (TODOs)**:
- [ ] Next.js プロジェクトのセットアップ（frontend/control-plane-ui/）
  - [ ] Next.js 14 + TypeScript + Tailwind CSS
  - [ ] ESLint + Prettier 設定
  - [ ] Vitest + React Testing Library セットアップ
- [ ] Keycloak 認証統合
  - [ ] NextAuth.js の設定
  - [ ] Keycloak OIDC プロバイダー設定
  - [ ] ログイン/ログアウトフロー
  - [ ] 認証ガード（middleware）
- [ ] レイアウト構築
  - [ ] ダッシュボードレイアウト（サイドバー + ヘッダー）
  - [ ] ナビゲーションメニュー
  - [ ] ブレッドクラム
- [ ] テナント管理機能
  - [ ] テナント一覧ページ（テーブル、検索、フィルター）
  - [ ] テナント詳細ページ
  - [ ] テナント作成フォーム
  - [ ] テナント編集フォーム
  - [ ] テナント削除確認ダイアログ
  - [ ] テナントステータス管理（停止/再開）
- [ ] ダッシュボードページ
  - [ ] システムメトリクス表示
  - [ ] アクティブテナント数
  - [ ] リソース使用量グラフ
- [ ] API クライアント実装
  - [ ] テナント管理 API クライアント
  - [ ] エラーハンドリング
  - [ ] リトライロジック
- [ ] テストの作成（カバレッジ 100%）
  - [ ] コンポーネントテスト
  - [ ] API クライアントテスト
  - [ ] E2E テスト（Playwright）

**ディレクトリ構造**:
```
frontend/
└── control-plane-ui/
    ├── app/                        # Next.js App Router
    │   ├── (auth)/                # 認証グループ
    │   │   ├── login/
    │   │   └── layout.tsx
    │   ├── (dashboard)/           # ダッシュボードグループ
    │   │   ├── layout.tsx         # ダッシュボードレイアウト
    │   │   ├── page.tsx           # ダッシュボードホーム
    │   │   ├── tenants/           # テナント管理
    │   │   │   ├── page.tsx       # テナント一覧
    │   │   │   ├── [id]/          # テナント詳細
    │   │   │   └── new/           # テナント作成
    │   │   └── settings/          # 設定
    │   ├── api/                   # API Routes
    │   │   └── auth/
    │   │       └── [...nextauth]/
    │   ├── layout.tsx             # ルートレイアウト
    │   └── page.tsx               # ホームページ
    ├── components/
    │   ├── ui/                    # 再利用可能な UI コンポーネント
    │   ├── forms/                 # フォームコンポーネント
    │   ├── layout/                # レイアウトコンポーネント
    │   └── tenants/               # テナント関連コンポーネント
    ├── lib/
    │   ├── api/                   # API クライアント
    │   │   ├── tenant-api.ts      # テナント管理 API
    │   │   └── client.ts          # HTTP クライアント
    │   ├── auth/                  # 認証ヘルパー
    │   ├── utils/                 # ユーティリティ
    │   └── types/                 # 型定義
    ├── test/
    │   ├── unit/                  # ユニットテスト
    │   ├── integration/           # 統合テスト
    │   └── e2e/                   # E2E テスト
    ├── public/                    # 静的ファイル
    ├── next.config.js
    ├── package.json
    ├── tsconfig.json
    ├── tailwind.config.ts
    └── vitest.config.ts
```

**画面設計（主要ページ）**:

1. **ダッシュボードページ** (`/`)
   - システムメトリクス（CPU、メモリ、ネットワーク）
   - アクティブテナント数
   - 直近のイベントログ
   - リソース使用量グラフ

2. **テナント一覧ページ** (`/tenants`)
   - テナント検索・フィルター
   - テナントステータス表示（Active, Suspended, Deleted）
   - ページネーション
   - テナント作成ボタン

3. **テナント詳細ページ** (`/tenants/[id]`)
   - テナント基本情報
   - Keycloak Realm 情報
   - リソース使用量
   - イベント履歴
   - アクション（編集、停止、削除）

4. **テナント作成ページ** (`/tenants/new`)
   - テナント名入力
   - 管理者メール入力
   - Tier 選択（Free, Pro, Enterprise）
   - 作成確認

**検証手順 (Validation)**:
1. Next.js ビルドが成功すること
   ```bash
   cd frontend/control-plane-ui
   bun run build
   ```

2. すべてのテストが通過すること（カバレッジ 100%）
   ```bash
   bun run test
   bun run test:coverage
   ```

3. Linter と Formatter が通過すること
   ```bash
   bun run lint
   bun run format:check
   ```

4. E2E テストが通過すること
   ```bash
   bun run test:e2e
   ```

5. Keycloak 認証フローが動作すること
   ```bash
   # ローカル環境でテスト
   bun run dev
   # http://localhost:3000 でログイン確認
   ```

**未解決の質問 (Open Questions)**:
- [ ] UI コンポーネントライブラリ: shadcn/ui vs Headless UI
- [ ] 状態管理: Zustand vs React Context vs なし
- [ ] テーマ: ダークモード対応するか
- [ ] 多言語対応: i18n を最初から入れるか
- [ ] Keycloak のローカル開発環境: Docker Compose vs kind

**進捗ログ (Progress Log)**:
- [2025-11-11 00:10] Control Plane UI の実装計画を Plan.md に追加

**振り返り (Retrospective)**:
*（実装後に記入）*

---

### Keycloak 認証基盤セットアップ - 2025-11-11

**目的 (Objective)**:
- Keycloak によるマルチテナント対応の認証・認可基盤を構築する
- ローカル開発環境で Keycloak + PostgreSQL を Docker Compose で起動可能にする
- Control Plane UI と Keycloak を OIDC で統合し、ログイン/ログアウトを実現する

**背景 (Background)**:
- TenkaCloud はマルチクラウド対応のため、クラウドベンダーロックインを避ける必要がある
- Keycloak は OSS の IdP（Identity Provider）で、OIDC/SAML 対応、エンタープライズグレード
- マルチテナント対応の Realm 設計が可能（マスター Realm + テナント別 Realm）
- Next.js との統合は NextAuth.js（Auth.js）を使用

**技術スタック**:
- **IdP**: Keycloak 23.x（最新安定版）
- **データベース**: PostgreSQL 16
- **コンテナ**: Docker Compose
- **認証ライブラリ**: NextAuth.js v5（Auth.js）
- **プロトコル**: OIDC（OpenID Connect）

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う
- セキュリティベストプラクティスの遵守
- パスワードポリシー: 最小 8 文字、大小英数字記号混在
- セッション管理: HttpOnly Cookie、SameSite=Lax

**タスク (TODOs)**:
- [ ] Docker Compose ファイル作成（Keycloak + PostgreSQL）
  - [ ] Keycloak コンテナ定義
  - [ ] PostgreSQL コンテナ定義
  - [ ] ネットワーク設定
  - [ ] ボリューム設定（データ永続化）
- [ ] Keycloak 初期設定スクリプト
  - [ ] マスター Realm 設定
  - [ ] TenkaCloud Realm 作成
  - [ ] Client 作成（control-plane-ui）
  - [ ] Role 定義（platform-admin, tenant-admin, user）
  - [ ] テストユーザー作成
- [ ] NextAuth.js セットアップ（Control Plane UI）
  - [ ] next-auth パッケージインストール
  - [ ] Keycloak Provider 設定
  - [ ] API Routes 作成（/api/auth/[...nextauth]）
  - [ ] Session Provider 設定
  - [ ] 認証ガード Middleware
- [ ] ログイン/ログアウトフロー実装
  - [ ] ログインページ作成
  - [ ] ログアウトボタン実装
  - [ ] セッション状態管理
  - [ ] 認証後のリダイレクト
- [ ] テストの作成
  - [ ] Keycloak 起動テスト
  - [ ] OIDC トークン取得テスト
  - [ ] 認証フローの E2E テスト

**ディレクトリ構造**:
```
infrastructure/
└── docker/
    └── keycloak/
        ├── docker-compose.yml       # Keycloak + PostgreSQL
        ├── .env.example             # 環境変数テンプレート
        ├── init/                    # 初期化スクリプト
        │   ├── realm-config.json    # Realm 設定
        │   └── setup.sh             # セットアップスクリプト
        └── README.md                # セットアップ手順

frontend/control-plane/
├── app/
│   ├── api/
│   │   └── auth/
│   │       └── [...nextauth]/
│   │           └── route.ts         # NextAuth.js API Routes
│   ├── (auth)/
│   │   └── login/
│   │       └── page.tsx             # ログインページ
│   └── layout.tsx                   # Session Provider
├── lib/
│   └── auth/
│       ├── auth-config.ts           # NextAuth.js 設定
│       └── auth-options.ts          # Keycloak Provider 設定
└── middleware.ts                    # 認証ガード
```

**Keycloak Realm 設計**:

1. **マスター Realm**（keycloak 標準）
   - Keycloak 管理用
   - プラットフォーム管理者のみアクセス

2. **TenkaCloud Realm**
   - Control Plane UI 用
   - Application UI 用（将来）
   - Client:
     - `control-plane-ui`: Control Plane 管理コンソール
     - `application-ui`: テナント向けバトル UI（将来）

3. **Role 定義**
   - **platform-admin**: プラットフォーム管理者（全テナント管理）
   - **tenant-admin**: テナント管理者（自テナントのみ管理）
   - **user**: 一般ユーザー（バトル参加者）

**環境変数設計**:
```env
# Keycloak
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=admin_password_change_me
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak
KC_DB_USERNAME=keycloak
KC_DB_PASSWORD=keycloak_password_change_me
KC_HOSTNAME=localhost
KC_HTTP_ENABLED=true
KC_HTTP_PORT=8080

# PostgreSQL
POSTGRES_DB=keycloak
POSTGRES_USER=keycloak
POSTGRES_PASSWORD=keycloak_password_change_me

# NextAuth.js
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key-change-me
KEYCLOAK_CLIENT_ID=control-plane-ui
KEYCLOAK_CLIENT_SECRET=your-client-secret
KEYCLOAK_ISSUER=http://localhost:8080/realms/tenkacloud
```

**検証手順 (Validation)**:
1. Keycloak が正常に起動すること
   ```bash
   cd infrastructure/docker/keycloak
   docker compose up -d
   # http://localhost:8080 で管理コンソールにアクセス
   ```

2. Realm と Client が作成されていること
   ```bash
   # Keycloak 管理コンソールで確認
   # - TenkaCloud Realm が存在
   # - control-plane-ui Client が存在
   # - Role が定義されている
   ```

3. NextAuth.js が Keycloak と連携できること
   ```bash
   cd frontend/control-plane
   bun run dev
   # http://localhost:3000/api/auth/signin にアクセス
   # Keycloak のログイン画面にリダイレクトされる
   ```

4. ログイン/ログアウトが動作すること
   ```bash
   # テストユーザーでログイン
   # セッション情報が取得できる
   # ログアウトで正常にセッションが破棄される
   ```

**未解決の質問 (Open Questions)**:
- [ ] Keycloak のバージョン: 23.x vs 24.x
- [ ] Realm 設計: マスター Realm のみ vs テナント別 Realm
- [ ] Client Secret の管理方法（開発環境 vs 本番環境）
- [ ] セッションストア: メモリ vs Redis（将来）
- [ ] MFA（多要素認証）を最初から有効化するか

**進捗ログ (Progress Log)**:
- [2025-11-11 23:30] Keycloak セットアップ実装計画を Plan.md に追加
- [2025-11-11 23:35] Docker Compose ファイル作成完了
  - Keycloak 23.0 + PostgreSQL 16 Alpine
  - ヘルスチェック設定
  - データ永続化ボリューム設定
- [2025-11-11 23:36] 環境変数サンプルファイル作成 (.env.example)
  - Keycloak 管理者認証情報
  - PostgreSQL 接続情報
  - NextAuth.js 統合用環境変数
- [2025-11-11 23:37] Keycloak セットアップ手順ドキュメント作成 (README.md)
  - クイックスタートガイド
  - Realm/Client/Role 設計
  - 初期設定手順
  - NextAuth.js 統合手順
  - トラブルシューティング
- [2025-11-11 23:38] .gitignore 追加（環境変数ファイル除外）

**振り返り (Retrospective)**:
*（実装後に記入）*

---

### NextAuth.js + Keycloak 認証統合 - 2025-11-13

**目的 (Objective)**:
- Control Plane UI に NextAuth.js v5 (Auth.js) を統合し、Keycloak による OIDC 認証を実現する
- ログイン/ログアウトフローを実装し、セッション管理を確立する
- 認証ガード Middleware を実装し、未認証ユーザーのアクセスを制御する

**背景 (Background)**:
- Keycloak は Docker Compose で起動済み（infrastructure/docker/keycloak）
- Control Plane UI は Next.js 14 + TypeScript でセットアップ済み
- NextAuth.js v5 は App Router に完全対応し、Keycloak Provider をサポート

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う（TDD、カバレッジ 100%）
- TypeScript strict mode
- セキュリティベストプラクティス（HttpOnly Cookie、SameSite=Lax）
- 環境変数は .env.local に格納し、.gitignore で除外

**タスク (TODOs)**:
- [ ] NextAuth.js パッケージのインストール
- [ ] 環境変数設定ファイルの作成（.env.local, .env.example）
- [ ] auth.ts の作成（NextAuth.js v5 設定）
- [ ] Keycloak Provider の設定
- [ ] API Routes の作成（app/api/auth/[...nextauth]/route.ts）
- [ ] Middleware の作成（認証ガード）
- [ ] Session Provider の設定（app/layout.tsx）
- [ ] ログインページの作成（app/(auth)/login/page.tsx）
- [ ] テストの作成（認証フロー）
- [ ] 検証（lint, typecheck, build）

**検証手順 (Validation)**:
1. パッケージがインストールされること
   ```bash
   cd frontend/control-plane
   bun install
   ```

2. Lint と型チェックが通過すること
   ```bash
   bun run lint
   bun run typecheck
   ```

3. ビルドが成功すること
   ```bash
   bun run build
   ```

4. Keycloak 連携が動作すること
   ```bash
   # Keycloak を起動
   cd infrastructure/docker/keycloak
   docker compose up -d

   # Next.js を起動
   cd frontend/control-plane
   bun run dev

   # http://localhost:3000 でログインフローを確認
   ```

**未解決の質問 (Open Questions)**:
- [ ] NextAuth.js v5 の最新安定版はどれか
- [ ] Keycloak Client の設定（Client ID, Secret）
- [ ] セッションストアは JWT のみか、Database も必要か
- [ ] テストは E2E のみか、ユニットテストも書くか

**進捗ログ (Progress Log)**:
- [2025-11-13 10:00] NextAuth.js 統合の実装計画を Plan.md に追加
- [2025-11-13 10:05] TODO リスト作成、実装開始
- [2025-11-13 10:10] NextAuth.js v5.0.0-beta.30 インストール完了
- [2025-11-13 10:15] 環境変数ファイル (.env.example) 作成完了
- [2025-11-13 10:20] auth.ts (NextAuth.js 設定) 作成完了
- [2025-11-13 10:25] 型定義ファイル (types/next-auth.d.ts) 作成完了
- [2025-11-13 10:30] API Routes (/api/auth/[...nextauth]/route.ts) 作成完了
- [2025-11-13 10:35] Middleware (認証ガード) 作成完了
- [2025-11-13 10:40] ログインページ作成完了
- [2025-11-13 10:45] ダッシュボードページ作成完了
- [2025-11-13 10:50] RootLayout と globals.css 作成完了
- [2025-11-13 10:55] 型チェック成功
- [2025-11-13 11:00] Biome lint/format 成功
- [2025-11-13 11:05] Next.js ビルド成功（警告: middleware → proxy 非推奨）

**振り返り (Retrospective)**:

##### 問題 (Problem)
Next.js 16 では `middleware.ts` が非推奨で `proxy.ts` に変更されている

##### 根本原因 (Root Cause)
Next.js 16 の仕様変更により、middleware ファイル名が変更された

##### 予防策 (Prevention)
- 将来的に `proxy.ts` にリネーム検討
- 現時点では警告のみでビルド成功しているため、動作には問題なし

---

### Makefile 改善: Docker ステータス確認コマンドの追加 - 2025-11-20

**目的 (Objective)**:
- 開発者が Docker コンテナの起動状態を一目で確認できるようにする
- `make docker-status` コマンドを追加し、Keycloak と Control Plane UI の状態を表示する
- ドキュメント (`docs/QUICKSTART.md`) を更新し、新しいコマンドの使用方法を記載する

**制約 (Guardrails)**:
- 既存の `check-docker` ターゲットを活用する
- 見やすいフォーマットで出力する
- `CLAUDE.md` のコンテキストを理解し、ドキュメント更新を徹底する

**タスク (TODOs)**:
- [x] Makefile に `docker-status` ターゲットを追加
- [x] Makefile の help に `docker-status` を追加
- [x] `docs/QUICKSTART.md` に `make docker-status` の説明を追加
- [x] 動作確認

**検証手順 (Validation)**:
- `make docker-status` を実行し、コンテナの状態が表示されることを確認
- `make help` に新しいコマンドが表示されることを確認

**進捗ログ (Progress Log)**:
- [2025-11-20 08:58] Makefile に `docker-status` コマンドを追加完了
- [2025-11-20 09:00] `docs/QUICKSTART.md` の更新に着手
- [2025-11-20 09:05] `docs/QUICKSTART.md` に `make docker-status` の説明を追加完了

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
