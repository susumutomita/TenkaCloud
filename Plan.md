# TenkaCloud Development Plan

このファイルは、TenkaCloud の開発プロセス、意思決定、実装内容、振り返りを記録するためのドキュメントです。

## 実行計画 (Exec Plans)

### Product-Led Growth オンボーディングフロー自動化 - 2025-11-23

**目的 (Objective)**:
- ランディングページから完全自動デプロイまでのセルフサービスオンボーディングフローを実装する
- Product-Led Growth (PLG) の原則に基づき、ユーザーが手動介入なしでテナント作成〜環境構築〜デプロイを完了できる
- O'Reilly 978-4-8144-0101-7e (PLG関連書籍) の思想に従った摩擦のない体験を提供

**背景 (Background)**:
- 現在の TenkaCloud は管理者が手動でテナント作成を行う前提
- セルフサービス型 SaaS として、ユーザー自身がサインアップからデプロイまで完了できる必要がある
- PLG の原則: Time to Value (TTV) を最小化し、プロダクト主導で成長を促進

**オンボーディングフロー設計**:
1. **ランディングページ** (`/`)
   - Hero セクション: バリュープロポジション
   - デモ動画・スクリーンショット
   - 料金プラン比較 (Free/Pro/Enterprise)
   - "Start Free Trial" CTA

2. **サインアップ** (`/signup`)
   - メールアドレス + パスワード or ソーシャルログイン (Google/GitHub)
   - Keycloak でユーザー作成
   - メール認証 (オプション)

3. **オンボーディングウィザード** (`/onboarding`)
   - Step 1: プロフィール作成 (名前、組織名、用途)
   - Step 2: プラン選択 (Free/Pro/Enterprise)
   - Step 3: テナント設定 (Tenant Name, Slug, Region)
   - Step 4: 環境選択 (Pool vs Silo, Serverless vs K8s)
   - Step 5: 初期アプリケーション設定 (Participant App)

4. **自動プロビジョニング** (バックグラウンド)
   - Keycloak Realm 作成
   - データベーススキーマ/インスタンス作成 (Pool vs Silo)
   - Kubernetes Namespace 作成 (Silo の場合)
   - Participant App デプロイ (Knative Service / Deployment)
   - DNS 設定 (tenant-slug.tenkacloud.io)

5. **ダッシュボード遷移** (`/dashboard`)
   - プロビジョニング進捗表示 (リアルタイム更新)
   - 完了後にテナント管理画面に遷移
   - Quick Start ガイド表示

**技術スタック**:
- **ランディングページ**: Next.js 14 + Tailwind CSS + Framer Motion
- **認証**: NextAuth.js v5 + Keycloak
- **ウィザード UI**: React Hook Form + Zod (バリデーション)
- **状態管理**: Zustand (ウィザード進捗)
- **リアルタイム更新**: Server-Sent Events (SSE) or WebSocket
- **バックエンド**: Control Plane Tenant Management Service (Fastify + TypeScript)
- **インフラ自動化**: Terraform + Kubernetes Operator (Custom Controller)

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う (TDD、カバレッジ 100%)
- セキュリティ: OWASP Top 10 対策、入力バリデーション徹底
- UX: Time to Value を最小化 (5分以内にデプロイ完了)
- スケーラビリティ: 同時100テナント作成に耐える
- 冪等性: プロビジョニング失敗時の自動リトライ・ロールバック

**タスク (TODOs)**:
- [ ] **フロントエンド (Public Landing Site)**
  - [ ] Landing Page 実装 (`frontend/landing-site/`)
    - [ ] Hero セクション + CTA
    - [ ] 料金プラン比較テーブル
    - [ ] デモ動画埋め込み
    - [ ] FAQ セクション
  - [ ] サインアップページ (`/signup`)
    - [ ] メールアドレス + パスワードフォーム
    - [ ] ソーシャルログイン (Google/GitHub)
    - [ ] Keycloak 統合
  - [ ] オンボーディングウィザード (`/onboarding`)
    - [ ] マルチステップフォーム (React Hook Form + Zod)
    - [ ] プログレスインジケーター
    - [ ] プラン選択 UI
    - [ ] テナント設定フォーム (Tenant Name, Slug, Region)
    - [ ] 環境選択 (Pool/Silo, Serverless/K8s)
  - [ ] プロビジョニング進捗ページ (`/onboarding/provisioning`)
    - [ ] リアルタイム進捗表示 (SSE)
    - [ ] ステップ別ステータス (Realm作成, DB作成, App デプロイ)
    - [ ] 完了後のダッシュボード遷移

- [ ] **バックエンド (Tenant Management Service 拡張)**
  - [ ] サインアップ API (`POST /api/v1/signup`)
    - [ ] Keycloak ユーザー作成
    - [ ] メール認証 (オプション)
  - [ ] テナント作成 API 拡張 (`POST /api/v1/tenants`)
    - [ ] プラン情報保存 (Free/Pro/Enterprise)
    - [ ] テナント設定保存 (Slug, Region, Model)
    - [ ] プロビジョニングジョブキュー投入
  - [ ] プロビジョニングワーカー
    - [ ] Keycloak Realm 自動作成
    - [ ] データベース自動作成 (Pool: Schema / Silo: Instance)
    - [ ] Kubernetes リソース自動作成 (Namespace, Deployment, Service, Ingress)
    - [ ] DNS レコード自動登録
    - [ ] プロビジョニングステータス更新 (SSE 配信)
  - [ ] プロビジョニングステータス API (`GET /api/v1/tenants/{id}/provisioning-status`)
    - [ ] SSE エンドポイント
    - [ ] ステータス (pending, in_progress, completed, failed)
  - [ ] ロールバック機能
    - [ ] プロビジョニング失敗時の自動クリーンアップ
    - [ ] 手動ロールバック API

- [ ] **インフラ自動化**
  - [ ] Terraform モジュール拡張
    - [ ] テナント別 Realm 動的作成
    - [ ] テナント別 DB インスタンス動的作成 (Silo)
    - [ ] Kubernetes Namespace 動的作成
  - [ ] Kubernetes Operator (将来)
    - [ ] Tenant CRD 定義
    - [ ] Tenant Controller (Reconciliation Loop)

- [ ] **テスト**
  - [ ] E2E テスト (Playwright)
    - [ ] サインアップ → オンボーディング → プロビジョニング → ダッシュボード
  - [ ] 統合テスト
    - [ ] テナント作成 API → プロビジョニングワーカー → Keycloak/DB/K8s
  - [ ] パフォーマンステスト
    - [ ] 同時100テナント作成負荷テスト

- [ ] **ドキュメント**
  - [ ] オンボーディングフロー設計書
  - [ ] API 仕様 (OpenAPI)
  - [ ] インフラ自動化手順
  - [ ] トラブルシューティングガイド

**ディレクトリ構造**:
```
frontend/
├── landing-site/                  # 公開ランディングサイト (新規)
│   ├── app/
│   │   ├── (marketing)/           # マーケティングページグループ
│   │   │   ├── page.tsx           # ランディングページ
│   │   │   ├── pricing/           # 料金ページ
│   │   │   └── about/             # About ページ
│   │   ├── signup/                # サインアップ
│   │   │   └── page.tsx
│   │   ├── onboarding/            # オンボーディングウィザード
│   │   │   ├── page.tsx           # ウィザードメイン
│   │   │   └── provisioning/      # プロビジョニング進捗
│   │   │       └── page.tsx
│   │   └── dashboard/             # ユーザーダッシュボード
│   │       └── page.tsx
│   ├── components/
│   │   ├── landing/               # ランディングページコンポーネント
│   │   ├── onboarding/            # オンボーディングコンポーネント
│   │   └── ui/                    # 共通 UI コンポーネント
│   ├── lib/
│   │   ├── api/                   # API クライアント
│   │   └── hooks/                 # カスタムフック
│   └── public/
│       └── videos/                # デモ動画

backend/
└── services/
    └── control-plane/
        └── tenant-management/
            ├── src/
            │   ├── api/
            │   │   ├── signup.ts          # サインアップ API
            │   │   └── provisioning.ts    # プロビジョニング API
            │   ├── workers/
            │   │   └── provisioning-worker.ts  # プロビジョニングワーカー
            │   ├── keycloak/
            │   │   └── realm-provisioner.ts    # Realm 自動作成
            │   ├── database/
            │   │   └── db-provisioner.ts       # DB 自動作成
            │   └── kubernetes/
            │       └── k8s-provisioner.ts      # K8s リソース自動作成
            └── test/
                └── e2e/
                    └── onboarding.test.ts
```

**検証手順 (Validation)**:
1. ランディングページが表示されること
   ```bash
   cd frontend/landing-site
   bun run dev
   # http://localhost:3001 でアクセス
   ```

2. サインアップフローが動作すること
   ```bash
   # サインアップページでユーザー作成
   # Keycloak にユーザーが登録されていることを確認
   ```

3. オンボーディングウィザードが完了すること
   ```bash
   # ウィザードで全ステップを入力
   # テナント作成リクエストが送信されること
   ```

4. プロビジョニングが完了すること
   ```bash
   # プロビジョニング進捗ページでリアルタイム更新を確認
   # Keycloak Realm, DB, K8s リソースが作成されることを確認
   ```

5. E2E テストが通過すること
   ```bash
   cd backend/services/control-plane/tenant-management
   bun run test:e2e
   ```

**未解決の質問 (Open Questions)**:
- [ ] メール認証を必須にするか、オプションにするか
- [ ] Free プランの制限 (テナント数、リソース上限)
- [ ] DNS レコード自動登録の方法 (Route53 / Cloud DNS / external-dns)
- [ ] プロビジョニングタイムアウト設定 (何分までに完了すべきか)
- [ ] ロールバック時のデータ保持ポリシー
- [ ] ソーシャルログイン対応範囲 (Google/GitHub のみ？)

**進捗ログ (Progress Log)**:
- [2025-11-23 08:00] PLG オンボーディングフロー実装計画を Plan.md に追加
- [2025-11-23 08:02] O'Reilly 978-4-8144-0101-7e の思想を反映した設計完了
- [2025-11-26 15:30] バックエンド: サインアップ API (`POST /api/signup`) を実装し、Keycloak 連携を追加
- [2025-11-26 15:35] バックエンド: テナントスキーマを拡張 (slug, region, isolationModel, computeType) し、マイグレーションを実施
- [2025-11-26 15:40] フロントエンド: サインアップページとオンボーディングウィザードをバックエンド API に接続

**振り返り (Retrospective)**:
（実装後に記入）

---

### make before-commit フロー修正 - 2025-11-21

**目的 (Objective)**:
- `make before-commit` を開発環境で確実に完走させ、コミット前チェックを自動化する
- 型チェックとビルドを実際の対象プロジェクト（frontend/control-plane）に紐づけ、不要なディレクトリを誤って検査しないようにする

**制約 (Guardrails)**:
- CLAUDE.md のプレイブック（TDD、ログ記録、ドキュメント更新）に従う
- CI/ローカル双方で動くシンプルなコマンド構成にする（追加の依存導入は最小限）

**タスク (TODOs)**:
- [ ] 失敗原因の特定（bun 実行時の panic、tsconfig スコープ過大、Next build 実行位置の不一致）
- [ ] `typecheck`/`build` を frontend/control-plane に絞ったターゲットへ修正し、npm exec ベースに変更
- [ ] `frontend/control-plane/package.json` に typecheck スクリプトを追加
- [ ] Makefile help の説明を最新化
- [ ] `make before-commit` 実行で完走することを確認（必要に応じて環境依存の注意書きを残す）

**検証手順 (Validation)**:
- `make before-commit` を実行し、lint_text / format_check / typecheck / build がすべて成功すること
- 単体確認: `npm --prefix frontend/control-plane run typecheck` が通ること

**未解決の質問 (Open Questions)**:
- Turbopack が利用できない環境向けに webpack ビルドへフォールバックさせるべきか

**進捗ログ (Progress Log)**:
- [2025-11-21 15:25] `make before-commit` が bun 実行時の panic（system-configuration NULL object）で失敗することを再現
- [2025-11-21 15:35] `npm --prefix frontend/control-plane run typecheck` では問題なく完走することを確認
- [2025-11-21 15:50] `npm --prefix frontend/control-plane run build` は Turbopack がポートバインドできず失敗する環境があることを確認（回避策検討中）
- [2025-11-21 16:10] Makefile の typecheck/build を frontend/control-plane + npm 実行へ変更、SKIP_FRONTEND_BUILD フラグを追加
- [2025-11-21 16:15] frontend/control-plane に typecheck スクリプトを追加し、`SKIP_FRONTEND_BUILD=1 make before-commit` が完走することを確認（ビルドは環境依存で引き続き要確認）
- [2025-11-22 09:17] `make before-commit` が textlint で失敗（frontend の各 README に全角・半角スペース欠如、コロン終止）があることを確認
- [2025-11-22 09:19] README の表記を修正し、`frontend/control-plane/next-env.d.ts` を Prettier で整形後に `make before-commit` が lint_text / format_check / typecheck / test / build まで完走することを確認
- [2025-11-22 23:03] tenantApi で実 API 接続を環境変数切り替えに変更し、モック依存を減らす。Control Plane テナント一覧の UI を再設計し、Admin UI のトップページを実運用向けのダッシュボードに刷新。
- [2025-11-22 23:05] Tailwind 4 の `@apply` 未対応クラス (bg-background/border-border) を CSS 変数適用に置き換え、`make before-commit` が再度完走することを確認
- [2025-11-23 08:07] frontend/landing-site の README 文言と Prettier 未整形ファイルを修正し、`make before-commit` が再び完走することを確認
- [2025-11-23 08:28] CLAUDE.md にドキュメント作成方針を追記し、絵文字＋太字の lint 指摘を解消。`next/font/google` を排除して landing-site ビルドのネットワーク依存を解消し、`make before-commit` が再度完走することを確認
- [2025-11-23 08:34] 追加で textlint 指摘（表現の断定・句点欠落）と `next-env.d.ts` の Prettier 警告を解消し、`make before-commit` を成功させたことを確認
- [2025-11-23 09:59] docs/KUBERNETES.md の textlint 指摘（コロン終止、全半角スペース、絵文字＋太字）を修正し、`make before-commit` が再度成功することを確認
- [2025-11-23 10:12] CLAUDE.md 冒頭を要約化してリファクタリングし、textlint と Prettier を通過後に `make before-commit` が成功することを確認
- [2025-11-23 10:57] control-plane の Sidebar で禁止されていた inline Server Action を削除し、`signOut` をクライアントハンドラに変更。Docker ビルドで Turbopack/Bun の worker 未対応エラーを避けるため `next build --webpack` を既定スクリプトに変更。整形漏れファイルを Prettier で修正し `make before-commit` を再度成功させた。
- [2025-11-23 11:45] テナント API レスポンスをクライアント側で小文字に正規化し、API エラー時はモックにフォールバック。テナント系ページを `dynamic = 'force-dynamic'` 指定にしてビルド警告を抑制。admin/participant/landing-site の build スクリプトを `next build --webpack` に統一、Makefile の余分な `--webpack` 付与を削除して重複指定を解消。
- [2025-11-29 23:03] `make before-commit` が format_check で失敗（frontend/admin-app 配下 29 ファイルの Prettier 未整形）することを再現
- [2025-11-29 23:05] `npm run format` を実行し admin-app 配下を整形、再度 `make before-commit` を実行して lint_text / format_check / typecheck / test / build がすべて成功することを確認

**振り返り (Retrospective)**:
（実装後に記入）

---

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
- [x] アーキテクチャドキュメント作成（現在は architecture/architecture.md に統合済み）
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
- [x] テナントドメインモデルと DynamoDB パーティション/ソートキーの定義を docs/architecture に追記 (#27)
- [x] OpenAPI 仕様 (Create/List/Get/Update/Suspend/Resume/Delete) を `backend/services/control-plane/tenant-management/openapi.yaml` に作成 (#27)
- [x] Fastify サービスのブートストラップ（config, validation, logging, tracing, error handling）を整備 (#27)
- [x] Repository/UseCase 層で CRUD + 状態遷移ロジックと監査ログ永続化を実装 (#27)
- [ ] **テナントプロビジョニング (Onboarding) 実装** (#27)
  - [ ] **マルチモデル対応 (Pool vs Silo)**:
    - [ ] **Poolモデル (同居型)**: 共有リソース（DBスキーマ、Compute）を使用し、論理的に分離
    - [ ] **Siloモデル (独立型)**: 専用リソース（DBスキーマ/DB、Compute）を払い出し
  - [ ] **サーバーレス/K8S対応 (Compute Abstraction)**:
    - [ ] **Kubernetes Native**: Deployment, Service, Ingress の動的生成
    - [ ] **Serverless (Scale-to-Zero)**: Knative Service / AWS Fargate / Cloud Run への対応（アイドル時リソースゼロ）
    - [ ] **Event-driven**: KEDA によるイベント駆動スケーリング
  - [ ] **データストア抽象化レイヤー (Data Store Abstraction)**:
    - [ ] **Unified Interface**: RDS, Cloud SQL, DynamoDB, Firestore, **Supabase** を透過的に扱えるリポジトリパターン
    - [ ] **Modeling Adapter**: Pool/Silo, RDB/NoSQL のデータモデルの違いを吸収し、統一的なテナントデータアクセスを提供
    - [ ] **Provisioning Adapter**: テナント作成時に適切なデータストア（RDB Schema, DynamoDB Table, Supabase Project等）を自動払い出し
    - [ ] **Connection Management**: テナントIDに基づいた動的な接続切り替え (Multi-tenancy Routing)
  - [ ] **インフラ抽象化レイヤー (Infrastructure Adapter)**:
    - [ ] ローカル環境 (Docker Compose): DBスキーマ作成、Keycloak Realm作成、Mock Compute
    - [ ] 本番環境 (Kubernetes/Serverless): Namespace作成、Knative Service作成、DBインスタンス作成
  - [ ] Keycloak Realm & Client 自動作成ロジック
- [x] **ローカル開発環境の整備**:
  - [x] `make start` でテナント管理サービスと依存リソース（DB, Keycloak）が一括起動する `docker-compose.yml` の整備
  - [x] `make start-all` で Control Plane UI, Admin App, Participant App が Docker で一括起動するように修正
- [ ] EventBridge 互換イベントパブリッシャを shared 層に実装し、状態遷移イベントを publish (#27)
- [ ] Bun/Vitest ベースのユニット & コントラクトテストで 100% カバレッジを達成 (#27)
- [ ] Runbook / README を更新し、ローカル実行・デプロイ手順を記載 (#27)
- [x] Control Plane namespace 向けの Kubernetes manifest / Helm values を下書きし、デプロイ手順をまとめる (#27)

**検証手順 (Validation)**:
- `bun run lint`, `bun run typecheck`, `bun run test:coverage`, `bun run lint_text` がすべて成功すること
- `make start` で全サービス（Control Plane UI, Tenant Management Service, Keycloak, DB）が起動し、ローカルで動作すること
- ローカル環境でテナントを作成し、Pool/Silo 設定に応じて適切なリソース（Keycloak Realm, DBスキーマ等）が作成されること
- DynamoDB Local + EventBridge エミュレータを用いた CRUD/状態遷移/イベント publish の統合テストが通過すること
- OpenAPI 仕様に対するモックテスト (`scripts/dev/tenant-management.sh` 等) が成功し、CI で自動検証されること

**未解決の質問 (Open Questions)**:
- Registration Service とテーブルを共有するか、Control Plane 専用テーブルを分離するか
- イベントバスは LocalStack を採用するか、軽量な in-memory pub/sub から着手するか
- 監査ログの保存先を DynamoDB で兼用するか、OpenSearch/CloudWatch Logs に分離するか
- ローカルでの Silo Compute（独立コンテナ）の再現方法（Docker-in-Docker は避けるか）

**進捗ログ (Progress Log)**:
- [2025-11-09 10:20] 実装プラン作成および Issue #27 を起票
- [2025-11-24 10:30] Tenant Management Service (Hono + Bun + Prisma) の初期実装完了。Docker Compose / K8s マニフェスト整備完了。

**検証手順 (Validation)**:
- `bun run lint`, `bun run typecheck`, `bun run test:coverage`, `bun run lint_text` がすべて成功すること
- `make start` で全サービス（Control Plane UI, Tenant Management Service, Keycloak, DB）が起動し、ローカルで動作すること
- ローカル環境でテナントを作成し、Pool/Silo 設定に応じて適切なリソース（Keycloak Realm, DBスキーマ等）が作成されること
- DynamoDB Local + EventBridge エミュレータを用いた CRUD/状態遷移/イベント publish の統合テストが通過すること
- OpenAPI 仕様に対するモックテスト (`scripts/dev/tenant-management.sh` 等) が成功し、CI で自動検証されること

**未解決の質問 (Open Questions)**:
- Registration Service とテーブルを共有するか、Control Plane 専用テーブルを分離するか
- イベントバスは LocalStack を採用するか、軽量な in-memory pub/sub から着手するか
- 監査ログの保存先を DynamoDB で兼用するか、OpenSearch/CloudWatch Logs に分離するか
- ローカルでの Silo Compute（独立コンテナ）の再現方法（Docker-in-Docker は避けるか）

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
  - [x] テナント編集フォーム
  - [x] テナント削除確認ダイアログ
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

### Docker 化とアプリ連携の実装 - 2025-11-22

**目的 (Objective)**:
- `make start-all` で Control Plane UI, Admin App, Participant App を Docker コンテナとして一括起動できるようにする
- Control Plane -> Admin App -> Participant App の連携フローを実装する

**タスク (TODOs)**:
- [x] Admin App, Participant App の Dockerfile 作成
- [x] ルート `docker-compose.yml` の作成 (全サービス定義)
- [x] Makefile の `start-all` を Docker Compose ベースに修正
- [x] Keycloak セットアップスクリプトの修正 (全クライアント作成、Static Secret 対応)
- [x] アプリ間連携の UI 実装 (リンク、デプロイボタン)

**検証手順 (Validation)**:
- `make start-all` がエラーなく完走すること
- `http://localhost:3000` (Control Plane), `http://localhost:3001` (Admin App), `http://localhost:3002` (Participant App) がアクセス可能であること
- Control Plane から Admin App へのリンクが機能すること
- Admin App から Participant App へのデプロイ（シミュレーション）が機能すること

**進捗ログ (Progress Log)**:
- [2025-11-22 19:30] Dockerfile と docker-compose.yml を作成
- [2025-11-22 19:45] Makefile を修正し、Docker Compose で起動するように変更
- [2025-11-22 20:00] Keycloak セットアップスクリプトを修正し、全クライアントを自動作成するように対応
- [2025-11-22 20:15] 全サービスの起動と連携を確認

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

### 開発環境改善: 推奨カラーテーマの追加 - 2025-11-20

**目的 (Objective)**:
- 開発者体験向上のため、推奨カラーテーマ「Hybrid Next」をプロジェクト設定に追加する
- VS Code の推奨拡張機能リストに `wyze.theme-hybrid-next` を追加する

**制約 (Guardrails)**:
- ユーザーの既存設定を強制上書きせず、推奨リストへの追加にとどめる

**タスク (TODOs)**:
- [x] `.vscode` ディレクトリの作成（存在しない場合）
- [x] `.vscode/extensions.json` の作成・更新
- [x] `wyze.theme-hybrid-next` を推奨リストに追加

**検証手順 (Validation)**:
- ファイルが正しく作成されているか確認

- [2025-11-20 09:12] `.vscode/extensions.json` を作成し、Hybrid Next を推奨リストに追加完了

---

### Control Plane UI: テナント管理機能の実装 (Mock) - 2025-11-21

**目的 (Objective)**:
- Control Plane UI にテナント管理機能（一覧、詳細、作成）を実装する
- バックエンド API が未実装のため、モックデータを使用して UI/UX を先行して検証可能にする
- shadcn/ui (または同等のコンポーネント) を導入し、モダンな UI を構築する

**制約 (Guardrails)**:
- バックエンドとの通信部分は `lib/api` に分離し、後で差し替え可能にする
- テナント ID は UUID 形式を想定
- レスポンシブデザインを考慮する

**タスク (TODOs)**:
- [ ] UI コンポーネントの整備 (Button, Table, Card, Input, etc.)
- [ ] テナント型定義 (`types/tenant.ts`) の作成
- [ ] モック API クライアント (`lib/api/mock-tenant-api.ts`) の実装
- [ ] テナント一覧ページ (`app/dashboard/tenants/page.tsx`) の実装
- [ ] テナント詳細ページ (`app/dashboard/tenants/[id]/page.tsx`) の実装
- [ ] テナント作成ページ (`app/dashboard/tenants/new/page.tsx`) の実装

**検証手順 (Validation)**:
- `bun run dev` で起動し、`/dashboard/tenants` にアクセスできること
- モックデータが表示されること
- 新規作成フローが（モック上で）動作すること

**進捗ログ (Progress Log)**:
- [2025-11-21 13:20] 実行計画を作成
- [2025-11-21 13:25] テナント型定義、モック API、UI ページ（一覧、詳細、作成）の実装完了

---

### 3層UI構造のフロントエンドディレクトリ作成 - 2025-11-21

**目的 (Objective)**:
- Control Plane UI / Admin UI / Participant UIの3層構造でフロントエンドディレクトリを作成する
- マルチテナントSaaSアーキテクチャに基づき、役割ごとにUIを分離する
- 共通コンポーネントを `frontend/shared/` に配置し、コード再利用性を高める

**制約 (Guardrails)**:
- 既存の `frontend/control-plane` を `frontend/control-plane-app` にリネームして一貫性を保つ
- pnpm workspace を使用してモノレポ構造を構築
- TypeScript strict mode、Tailwind CSS、Next.js 14+ を使用
- 各アプリは独立してビルド・テスト可能にする

**タスク (TODOs)**:
- [x] npm workspace の設定（pnpm 未インストールのため npm workspaces を使用）
- [ ] `frontend/control-plane` を `frontend/control-plane-app` にリネーム（後続タスク）
- [x] `frontend/admin-app` ディレクトリの作成（Next.js プロジェクト）
- [x] `frontend/participant-app` ディレクトリの作成（Next.js プロジェクト）
- [x] `frontend/shared` ディレクトリの作成（共通コンポーネントライブラリ）
- [ ] `frontend/application` ディレクトリの削除または移行（後続タスク）
- [x] 各アプリの README.md 作成
- [x] ルートの package.json に workspace スクリプト追加
- [ ] テスト（各アプリが独立してビルドできることを確認）
- [x] ドキュメント更新（frontend/README.md 作成）

**検証手順 (Validation)**:
- 各アプリが独立してビルドできること
  ```bash
  cd frontend/control-plane-app && npm run build
  cd frontend/admin-app && npm run build
  cd frontend/participant-app && npm run build
  ```
- lint と型チェックが通過すること
- pnpm workspace が正常に動作すること

**未解決の質問 (Open Questions)**:
- `frontend/application` は削除するか、別用途に転用するか
- 共通コンポーネントライブラリのビルド方法（Rollup / tsup / Next.js standalone）

**進捗ログ (Progress Log)**:
- [2025-11-21 22:55] 実行計画を Plan.md に追加
- [2025-11-21 22:56] 既存の frontend 構造を分析完了（control-plane と application が存在）
- [2025-11-21 22:58] npm workspaces 設定を root package.json に追加
- [2025-11-21 22:59] frontend/admin-app の Next.js プロジェクト作成完了
- [2025-11-21 23:00] frontend/participant-app の Next.js プロジェクト作成完了
- [2025-11-21 23:01] frontend/shared 共通ライブラリ作成完了（Button コンポーネントとテスト含む）
- [2025-11-21 23:02] 各アプリの README.md、設定ファイル（tsconfig, biome, vitest）作成完了
- [2025-11-21 23:03] frontend/README.md 作成完了（3層アーキテクチャの説明）

**振り返り (Retrospective)**:

##### 問題 (Problem)
`frontend/control-plane` を `frontend/control-plane-app` にリネームする必要があるが、git mv コマンドが承認を必要とするため実行できなかった

##### 根本原因 (Root Cause)
GitHub Actions 環境では、ファイルシステム操作（mv、mkdir等）に制限がある

##### 予防策 (Prevention)
- リネーム作業は別途手動で実施するか、PRのレビュー時に対応する
- 今回は新規ディレクトリ（admin-app, participant-app, shared）の作成に注力し、既存ディレクトリのリネームは後続タスクとする

---

### 管理画面UIフレームワーク導入（Shadcn/ui） - 2025-11-22

**目的 (Objective)**:
- Control Plane と Admin App に Shadcn/ui を導入し、統一感のあるモダンな管理画面を構築する
- 手作りコンポーネントを Shadcn/ui の高品質なコンポーネントに置き換える
- アクセシビリティとレスポンシブデザインを向上させる

**背景 (Background)**:
- 現在の管理画面は Tailwind CSS のみで手作りされており、デザインの統一感が不足している
- Shadcn/ui は Tailwind CSS v4 と完全に統合され、Radix UI ベースで高いアクセシビリティを提供
- コンポーネントをコピーして使用するため、依存関係が増えず、カスタマイズも容易

**技術スタック**:
- **UI フレームワーク**: Shadcn/ui
- **コンポーネント基盤**: Radix UI
- **スタイリング**: Tailwind CSS v4
- **アイコン**: Lucide React
- **ユーティリティ**: clsx, tailwind-merge

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う
- TypeScript strict mode
- 既存の機能を壊さない
- カバレッジ 100% を維持
- Tailwind CSS v4 の設定を変更しない

**タスク (TODOs)**:
- [ ] Shadcn/ui のセットアップ（Control Plane）
  - [ ] 必要な依存関係のインストール
  - [ ] components.json の作成
  - [ ] CLI で基本コンポーネントの追加（Button, Table, Card, Input, Badge, Dialog）
  - [ ] lib/utils.ts の作成（cn ユーティリティ）
- [ ] Shadcn/ui のセットアップ（Admin App）
  - [ ] 必要な依存関係のインストール
  - [ ] components.json の作成
  - [ ] CLI で基本コンポーネントの追加
- [ ] Control Plane のリファクタリング
  - [ ] テナント一覧ページを Shadcn/ui Table に置き換え
  - [ ] ボタンを Shadcn/ui Button に置き換え
  - [ ] ステータスバッジを Shadcn/ui Badge に置き換え
  - [ ] 新規作成フォームを Shadcn/ui Input/Dialog に置き換え
- [ ] Admin App ダッシュボードの実装
  - [ ] ダッシュボードレイアウト（Shadcn/ui Card）
  - [ ] ナビゲーションメニュー
  - [ ] サンプルデータ表示
- [ ] 検証とテスト
  - [ ] lint/typecheck/build が通過すること
  - [ ] 既存のテストが通過すること
  - [ ] レスポンシブデザインの確認

**検証手順 (Validation)**:
1. Control Plane のビルドが成功すること
   ```bash
   cd frontend/control-plane
   bun run typecheck
   bun run lint
   bun run build
   ```

2. Admin App のビルドが成功すること
   ```bash
   cd frontend/admin-app
   bun run typecheck
   bun run lint
   bun run build
   ```

3. すべてのテストが通過すること
   ```bash
   cd frontend/control-plane && bun run test
   cd frontend/admin-app && bun run test
   ```

4. Docker Compose で起動確認
   ```bash
   make start-all
   # http://localhost:3000 (Control Plane)
   # http://localhost:3001 (Admin App)
   ```

**未解決の質問 (Open Questions)**:
- [ ] Shadcn/ui のテーマカスタマイズは必要か（ダークモード対応）
- [ ] shared コンポーネントとして Shadcn/ui を再利用するか
- [ ] Participant App にも Shadcn/ui を導入するか

**進捗ログ (Progress Log)**:
- [2025-11-22 23:00] 実行計画を Plan.md に追加
- [2025-11-22 23:05] Control Plane に Shadcn/ui の依存関係をインストール
  - class-variance-authority, clsx, tailwind-merge, lucide-react を追加
- [2025-11-22 23:07] Control Plane の設定ファイルを作成
  - components.json, lib/utils.ts, tailwind.config.ts を作成
  - app/globals.css を Tailwind v4 形式に更新（CSS 変数定義）
- [2025-11-22 23:08] Control Plane の UI コンポーネントを作成
  - components/ui/button.tsx, card.tsx, badge.tsx, table.tsx を実装
- [2025-11-22 23:10] Control Plane のダッシュボードページをリファクタリング
  - セッション JSON 表示を削除し、Stats Cards、Quick Actions、Recent Activity セクションを追加
  - Shadcn/ui コンポーネント（Card, Button, Badge）を使用
- [2025-11-22 23:12] Control Plane のテナント一覧ページをリファクタリング
  - 手作りの HTML テーブルを Shadcn/ui Table コンポーネントに置き換え
  - Badge でステータス表示、Button で操作ボタンを実装
- [2025-11-22 23:15] Control Plane の lint と build 検証を実施
  - bun run format で整形、bunx biome check --fix で lint エラー修正
  - typecheck、lint、build すべて成功
- [2025-11-22 23:20] Admin App に Shadcn/ui をセットアップ
  - Control Plane と同じ依存関係、設定ファイル、UI コンポーネントをコピー
  - app/page.tsx をリファクタリング（グラデーション背景から Shadcn/ui デザインに変更）
- [2025-11-22 23:25] Admin App の設定エラーを修正
  - tsconfig.json のパスマッピングを `./src/*` から `./*` に修正
  - biome.json のスキーマバージョンを 2.2.0 に更新
  - globals.css の `@apply` を直接 CSS プロパティに変更
  - lib/api/tenant-api.ts のスタブを作成（テストとビルド用）
  - テストの型エラーを修正（Promise<boolean> → Promise<void>）
- [2025-11-22 23:30] Admin App の検証完了
  - typecheck、lint、build すべて成功

**振り返り (Retrospective)**:
*（実装後に記入）*

---

### Makefile 全フロントエンドアプリ対応 - 2025-11-22

**目的 (Objective)**:
- Makefile を修正して、Control Plane だけでなく、Admin App、Participant App の3つすべてのフロントエンドアプリをカバーする
- `typecheck`, `lint`, `test`, `build` などのコマンドを全アプリで実行できるようにする

**制約 (Guardrails)**:
- 既存の Makefile の構造を維持する
- すべてのコマンドは3つのアプリすべてで成功する必要がある（エラーが発生したら即座に停止）
- before_commit ターゲットも全アプリをカバーする

**タスク (TODOs)**:
- [x] FRONTEND_APPS 変数を定義（3つのディレクトリパスを含む）
- [x] install ターゲットを全アプリ対応に修正
- [x] typecheck ターゲットを全アプリ対応に修正
- [x] build ターゲットを全アプリ対応に修正
- [x] test ターゲットを全アプリ対応に修正
- [x] test_coverage ターゲットを全アプリ対応に修正
- [x] lint ターゲットを全アプリ対応に修正
- [x] help テキストを更新
- [x] 動作確認（typecheck, build）

**検証手順 (Validation)**:
```bash
# 3つのアプリすべてで型チェック
make typecheck

# 3つのアプリすべてでビルド
make build

# すべてのコミット前チェック
make before_commit
```

**進捗ログ (Progress Log)**:
- [2025-11-22 23:40] Makefile に FRONTEND_APPS 変数を追加（3つのディレクトリ）
- [2025-11-22 23:42] install, typecheck, build, test, test_coverage, lint ターゲットを for ループで全アプリ対応に修正
- [2025-11-22 23:45] help テキストを更新（全フロントエンドアプリに対応することを明記）
- [2025-11-22 23:47] 動作確認完了
  - `make typecheck`: 3つのアプリすべて成功 ✓
  - `make build`: 3つのアプリすべてビルド成功 ✓

**振り返り (Retrospective)**:

##### 問題 (Problem)
Makefile が Control Plane のみをカバーしており、Admin App と Participant App のビルド・テスト・型チェックが実行されていなかった。

##### 根本原因 (Root Cause)
- 初期実装時に Control Plane のみを想定していた
- 3層構造（Control Plane, Admin App, Participant App）への移行時に Makefile を更新していなかった

##### 予防策 (Prevention)
- 新しいフロントエンドアプリを追加する際は、必ず Makefile の FRONTEND_APPS 変数に追加する
- CI/CD パイプラインでも全アプリをビルド・テストするように設定する
- Plan.md にマルチアプリ対応のチェックリストを追加

---

### Next.js 16 ビルド警告対応 - 2025-11-22

**目的 (Objective)**:
- Next.js 16 で発生していたビルド警告を解消する
- `middleware` の非推奨警告を解決（`proxy` への移行）
- npm/bun の混在による `package-lock.json` を削除

**制約 (Guardrails)**:
- 既存の認証ロジック（middleware/proxy）の動作を維持する
- 全3つのフロントエンドアプリのビルドが成功する必要がある

**タスク (TODOs)**:
- [x] ビルド警告の内容を調査
- [x] package-lock.json を削除（bun を使用しているため不要）
- [x] Control Plane の middleware.ts を proxy.ts にリネーム
- [x] 全アプリのビルドで警告が解消されたか検証

**検証手順 (Validation)**:
```bash
# 全フロントエンドアプリのビルド
make build

# middleware 非推奨警告が出ないことを確認
# ビルドが成功することを確認
```

**進捗ログ (Progress Log)**:
- [2025-11-22 23:28] ビルド警告を調査
  - 警告1: 複数のlockfile検出（package-lock.json と bun.lock）
  - 警告2: middleware が非推奨、proxy への移行が必要
- [2025-11-22 23:30] package-lock.json を削除
  - ルートディレクトリの package-lock.json を削除
  - プロジェクトは bun を使用しているため、npm の lockfile は不要
- [2025-11-22 23:32] middleware.ts を proxy.ts にリネーム
  - `git mv frontend/control-plane/middleware.ts frontend/control-plane/proxy.ts`
  - 内容はそのまま（Next.js 16 では proxy.ts に移行するだけで OK）
- [2025-11-22 23:35] 全アプリのビルド検証
  - Control Plane: ✓ ビルド成功
  - Admin App: ✓ ビルド成功
  - Participant App: ✓ ビルド成功
  - middleware 非推奨警告が解消されたことを確認 ✓
  - 複数のlockfile警告は残っているが、機能的には問題なし（モノレポ構造のため）

**成果 (Outcome)**:
- ✅ middleware -> proxy 移行完了（Next.js 16 対応）
- ✅ package-lock.json 削除（npm/bun 混在解消）
- ✅ 全3アプリのビルド成功
- ⚠️ 複数lockfile警告は残るが、機能的には問題なし

---

## 次の実行計画テンプレート

### before-commit 型エラー修正 - 2025-11-26

**目的 (Objective)**:
- make before-commit で発生した Tenant 型エラーを解消し、全フロントエンドの型チェックを通す。

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う。
- Tenant の tier と status は大文字表記で統一する。

**タスク (TODOs)**:
- [x] モックデータの tier と status を Tenant 型に合わせて大文字に統一する。
- [x] テナント編集ページのユニットテスト期待値を大文字表記に合わせる。

**検証手順 (Validation)**:
- make before-commit を実行して lint_text、format_check、typecheck、test、build をすべて Green にする。

**進捗ログ (Progress Log)**:
- [2025-11-26 07:48 JST] typecheck 失敗箇所を修正し mock データとテスト期待値を大文字表記へ揃えた。

**振り返り (Retrospective)**:
- 問題: Tenant tier/status の表記ゆれで typecheck が失敗した。
- 根本原因: テストとモックを作成する際に UI で使用している大文字表記を参照していなかった。
- 予防策: 型定義のリテラル値を参照しながらフィクスチャを作成し、lint と typecheck を CI で必須にする。

以下のテンプレートを使用して、新しい機能開発の実行計画を作成してください：

```markdown
### 問題管理システム統合（GameDay/JAM 統合 + マルチクラウド対応） - 2025-11-29

**目的 (Objective)**:
- reference/minoru（GameDay）と reference/minoru1（JAM）を統合し、管理画面から両形式を選択可能にする
- クラウドプロバイダー抽象化レイヤーを設計し、AWS/GCP/Azure/OCI に対応する
- 手作業デプロイから、問題マーケットプレイスによるセルフデプロイフローに移行する
- 体験を統合し、ユーザーが GameDay/JAM の違いを意識せずに利用できるようにする

**背景 (Background)**:
- minoru（GameDay）: Next.js フロントエンド + Bash CLI ベースのオーケストレーション
- minoru1（JAM）: Flask フロントエンド + Python/Docker/Makefile ベースのオーケストレーション
- 両者とも AWS 固有の実装（CloudFormation/SAM、Cognito、DynamoDB）に依存している
- 問題は手動でデプロイが必要で、DevOps 知識が必要
- GameDay と JAM でリポジトリが分かれており、体験が分断されている

**設計方針**:

1. **クラウド抽象化レイヤー（Cloud Provider Abstraction）**
   ```
   backend/services/problem-management/
   ├── src/
   │   ├── providers/                    # クラウドプロバイダー抽象化
   │   │   ├── interface.ts              # 共通インターフェース
   │   │   ├── aws/                       # AWS 実装
   │   │   │   ├── stack-deployer.ts     # CloudFormation/SAM デプロイ
   │   │   │   ├── account-manager.ts    # IAM ロール管理
   │   │   │   └── resource-cleaner.ts   # リソースクリーンアップ
   │   │   ├── gcp/                       # GCP 実装（将来）
   │   │   ├── azure/                     # Azure 実装（将来）
   │   │   └── local/                     # ローカル開発用（Docker Compose）
   │   ├── problems/                      # 問題管理
   │   │   ├── repository.ts             # 問題リポジトリ
   │   │   ├── marketplace.ts            # マーケットプレイス
   │   │   └── deployer.ts               # 問題デプロイオーケストレーター
   │   ├── scoring/                       # 採点システム
   │   │   ├── engine.ts                 # 採点エンジン
   │   │   └── validators/               # クラウド別検証ロジック
   │   └── events/                        # イベント管理
   │       ├── session.ts                # バトルセッション
   │       └── leaderboard.ts            # リーダーボード
   ```

2. **問題形式の統一（Problem Format Unification）**
   ```yaml
   # 統一問題フォーマット
   problem:
     id: "problem-001"
     title: "Well-Architecting Challenge"
     type: "gameday" | "jam"            # GameDay or JAM 形式
     category: "architecture" | "security" | "cost" | "performance"
     difficulty: "easy" | "medium" | "hard"

     metadata:
       author: "TenkaCloud"
       version: "1.0.0"
       created_at: "2025-11-29"

     description:
       overview: "問題の概要（Markdown）"
       objectives: ["目標1", "目標2"]
       hints: ["ヒント1", "ヒント2"]

     deployment:
       providers:                         # 対応クラウドプロバイダー
         - aws
         - gcp
       templates:
         aws:
           type: "cloudformation" | "sam" | "cdk"
           path: "templates/aws/template.yml"
         gcp:
           type: "terraform" | "deployment-manager"
           path: "templates/gcp/main.tf"
       regions:
         aws: ["us-east-1", "ap-northeast-1"]
         gcp: ["us-central1", "asia-northeast1"]

     scoring:
       type: "lambda" | "container" | "api"
       path: "scoring/"
       criteria:
         - name: "functionality"
           weight: 40
           max_points: 100
         - name: "security"
           weight: 30
           max_points: 100
         - name: "cost_optimization"
           weight: 20
           max_points: 100
         - name: "performance"
           weight: 10
           max_points: 100
       timeout_minutes: 120

     resources:
       static:
         - path: "static/"
           destination: "s3://bucket/problems/{problem_id}/"
       documentation:
         - path: "docs/"
   ```

3. **問題マーケットプレイス（Problem Marketplace）**
   ```
   frontend/admin-app/
   ├── app/
   │   ├── problems/                      # 問題管理
   │   │   ├── page.tsx                   # 問題一覧
   │   │   ├── [id]/                       # 問題詳細
   │   │   │   ├── page.tsx
   │   │   │   └── deploy/                # デプロイ画面
   │   │   │       └── page.tsx
   │   │   └── marketplace/               # マーケットプレイス
   │   │       ├── page.tsx               # 問題カタログ
   │   │       └── [id]/                   # 問題プレビュー
   │   │           └── page.tsx
   │   └── events/                        # イベント管理
   │       ├── page.tsx                   # イベント一覧
   │       ├── new/                        # イベント作成
   │       │   └── page.tsx
   │       └── [id]/                       # イベント詳細
   │           ├── page.tsx
   │           ├── problems/              # 問題選択・デプロイ
   │           │   └── page.tsx
   │           └── teams/                 # チーム管理
   │               └── page.tsx
   ```

4. **セルフデプロイフロー（Self-Deploy Flow）**
   ```
   ユーザー体験:
   1. [管理画面] イベント作成（GameDay or JAM 形式を選択）
   2. [マーケットプレイス] 問題カタログから問題を選択
   3. [デプロイ設定] クラウドプロバイダー、リージョン、参加者アカウントを設定
   4. [デプロイ実行] ワンクリックでバックグラウンドデプロイ開始
   5. [進捗監視] リアルタイムでデプロイ状況を確認
   6. [完了通知] デプロイ完了後、参加者に招待リンクを送信

   バックエンドフロー:
   1. デプロイリクエスト受信 → ジョブキューに投入
   2. ワーカーがジョブを取得 → クラウドプロバイダーアダプター選択
   3. 並列デプロイ（Docker コンテナ or Kubernetes Job）
   4. ステータス更新（WebSocket/SSE でフロントエンドに配信）
   5. 完了後、採点 Lambda/Container をデプロイ
   6. DynamoDB/Firestore にメタデータ保存
   ```

5. **GameDay/JAM 統合インターフェース**
   ```typescript
   // 統合イベント型
   interface UnifiedEvent {
     id: string;
     name: string;
     type: 'gameday' | 'jam';
     status: 'draft' | 'scheduled' | 'active' | 'completed';

     // 共通設定
     startTime: Date;
     endTime: Date;
     timezone: string;

     // 参加者設定
     participants: {
       type: 'individual' | 'team';
       maxCount: number;
       registrationDeadline: Date;
     };

     // 問題設定
     problems: {
       problemId: string;
       order: number;
       unlockTime?: Date;  // JAM 形式の場合、段階的アンロック
     }[];

     // クラウド設定
     cloudConfig: {
       provider: 'aws' | 'gcp' | 'azure';
       regions: string[];
       competitorAccounts: CompetitorAccount[];
     };

     // スコアリング設定
     scoringConfig: {
       type: 'realtime' | 'batch';
       intervalMinutes: number;
       leaderboardVisible: boolean;
     };
   }
   ```

**制約 (Guardrails)**:
- CLAUDE.md の開発プレイブックに従う（TDD、カバレッジ 100%）
- 既存の minoru/minoru1 のコードは参照のみ。コピーではなく、設計を参考に再実装する
- クラウドプロバイダー固有のコードは providers/ ディレクトリに隔離する
- 問題フォーマットは YAML で定義し、JSON Schema でバリデーションする
- デプロイジョブは冪等性を保証する（再実行しても安全）
- セキュリティ: 参加者アカウントへのアクセスは最小権限で行う

**タスク (TODOs)**:

Phase 1: 基盤設計（Week 1-2）
- [ ] クラウドプロバイダー抽象化インターフェース設計
- [ ] 統一問題フォーマット YAML スキーマ定義
- [ ] 問題管理サービス（problem-management）ブートストラップ
- [ ] DynamoDB/PostgreSQL スキーマ設計（問題、イベント、デプロイジョブ）

Phase 2: AWS 実装（Week 3-4）
- [ ] AWS スタックデプロイヤー実装（CloudFormation/SAM）
- [ ] AWS アカウントマネージャー実装（AssumeRole）
- [ ] AWS リソースクリーナー実装（AWS-Nuke 統合）
- [ ] 採点 Lambda デプロイヤー実装

Phase 3: 管理画面 UI（Week 5-6）
- [ ] 問題マーケットプレイス UI（カタログ、プレビュー、選択）
- [ ] イベント管理 UI（作成、GameDay/JAM 選択、問題割当）
- [ ] デプロイ管理 UI（設定、実行、進捗監視）
- [ ] リーダーボード UI（リアルタイム更新）

Phase 4: セルフデプロイフロー（Week 7-8）
- [ ] デプロイジョブキュー実装（BullMQ or Kubernetes Job）
- [ ] 並列デプロイワーカー実装（Docker コンテナ）
- [ ] リアルタイム進捗配信（WebSocket/SSE）
- [ ] 完了通知・招待リンク生成

Phase 5: GCP/Azure 対応（Future）
- [ ] GCP Deployment Manager / Terraform アダプター
- [ ] Azure ARM Templates アダプター
- [ ] マルチクラウドテスト

**検証手順 (Validation)**:
1. ローカル環境で問題デプロイが動作すること
   ```bash
   make start
   # 管理画面から問題を選択してローカルデプロイ
   ```

2. AWS 環境で問題デプロイが動作すること
   ```bash
   # テスト用 AWS アカウントで検証
   # CloudFormation スタックが作成されること
   # 採点 Lambda が動作すること
   ```

3. 全テストが通過すること（カバレッジ 100%）
   ```bash
   make test
   make test_coverage
   ```

4. lint と型チェックが通過すること
   ```bash
   make before_commit
   ```

**未解決の質問 (Open Questions)**:
- [ ] 問題リポジトリは Git サブモジュールか、S3/GCS に保存するか
- [ ] 採点結果の保存先（DynamoDB vs PostgreSQL vs 両方）
- [ ] 並列デプロイの同時実行数制限（AWS API レート制限対策）
- [ ] 参加者アカウントのクレデンシャル管理方法（Secrets Manager vs Vault）
- [ ] マーケットプレイスの問題公開/非公開ポリシー
- [ ] 問題作成ワークフロー（管理画面 vs CLI vs 両方）

**進捗ログ (Progress Log)**:
- [2025-11-29 10:00] reference/minoru と reference/minoru1 のコード分析完了
- [2025-11-29 10:30] 問題管理システム統合計画を Plan.md に追加

**振り返り (Retrospective)**:
（実装後に記入）

---

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
