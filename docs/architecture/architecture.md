# TenkaCloud Architecture

この文書は、TenkaCloud の責務分割と主要コンポーネントを定義するアーキテクチャの正本です。将来案や検討メモは含めません。

## 1. 全体像

TenkaCloud は、Control Plane と Application Plane を分離したマルチテナント構成を採用しています。

この文書だけで原則を持たず、アーキテクチャ不変条件の正本は [`docs/architecture/harness.md`](./harness.md) とします。`Codex` と `Claude Code` のどちらが触っても、`bun scripts/architecture-harness.ts --staged --fail-on=error` を通らない変更は受け入れません。

```text
┌─────────────────────────────────────────────────────────────┐
│                        TenkaCloud                           │
├─────────────────────────────────────────────────────────────┤
│ Control Plane                                               │
│ - client/AdminWeb (Next.js, basePath=/control)              │
│ - server/microservices/tenant-management                    │
│ - infrastructure/cdk (SBT 0.3.9 ベース)                     │
│                                                             │
│ Application Plane                                           │
│ - client/Application (Next.js)                              │
│ - server/microservices/{problem,gameday,battle,             │
│                         scoring,leaderboard}-service        │
├─────────────────────────────────────────────────────────────┤
│ Shared                                                      │
│ - server/libs/*                                             │
│ - packages/*                                                │
│ - problems/*                                                │
└─────────────────────────────────────────────────────────────┘
```

## 2. プレーンごとの責務

## Architecture Invariants

- `INVARIANT_SERVERLESS_ONLY`
- `INVARIANT_TENANT_IS_COMPANY`
- `INVARIANT_DEPARTMENT_IS_NOT_TENANT`
- `INVARIANT_ONE_APPLICATION_PLANE_PER_TENANT`
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`
- `INVARIANT_PROBLEM_RUNTIME_IN_COMPETITOR_AWS_ACCOUNTS`
- `ONE_PASS_LOCAL`
- `ONE_PASS_AWS`

### Control Plane

共有運用面を担います。

- テナント管理
- 運用設定
- 共通管理 UI
- 登録、プロビジョニング、ユーザー管理の導線
- tenant provisioning request と監査

Control Plane は tenant manager であり、tenant runtime host ではありません。tenant ごとの実行系 endpoint を直接抱え込まず、event-driven provisioning で tenant Application Plane を起動・追跡します。

主要実体は以下のとおりです。

- UI: `client/AdminWeb` (Next.js, `basePath=/control`)
- Services: `server/microservices/tenant-management`
- Infra: `infrastructure/cdk` (SBT 0.3.9 ベースの Cognito + EventBridge + tenant CRUD Lambda)

> 旧構造で `backend/services/control-plane/{registration, provisioning, provisioning-completion, user-management, system-management, deployment-management}` として独立 Lambda に分かれていた責務は、SBT 移行 (ADR-013) と再構成 (ADR-014) を経て、SBT が提供する Cognito UserPool と EventBridge ルール、および `tenant-management` 内の provisioning publisher (`server/microservices/tenant-management/src/provisioning/publisher.ts`) に集約された。Lambda 単位での分割は廃止。

### Application Plane

競技体験とテナント業務面を担います。

- GameDay イベント
- Battle セッション
- 問題管理
- スコアリング
- リーダーボード
- tenant admin UI と participant UI
- competitor AWS account への問題デプロイ

Application Plane は tenant ごとに 1 つです。各社ごとに 1 Plane を持ち、部署ごとには分けません。

主要実体は以下のとおりです。

- UI: `client/Application` (Next.js)
- Services:
  - `server/microservices/problem-service`
  - `server/microservices/gameday-service`
  - `server/microservices/battle-service`
  - `server/microservices/scoring-service`
  - `server/microservices/leaderboard-service`
- tenant プロビジョニング実行: `infrastructure/cdk/lib/{bootstrap-template,tenant-template,tenant-pipeline}/` 配下の SBT スタック (旧 `backend/services/application-plane/tenant-provisioner` の Lambda は廃止)
- realtime 系 (旧 `realtime-service` Lambda) は polling ベースに切り替え済み (PR #412 / `INVARIANT_POLLING_OVER_SSE` メモリ参照)

## 3. UI 構成

### `client/AdminWeb`

- Next.js 16 (`output: 'standalone'`, `basePath=/control`)
- ポート `13000`
- 主に `/control/dashboard/*` 配下でプラットフォーム管理を提供
- 認証は NextAuth v5 + Cognito (本番) / `AUTH_SKIP=1` (ローカル)
- SBT API は `lib/api/sbt-api-adapter.ts` 経由 (詳細は [ADR-013](../decisions/013-sbt-control-plane-onboarding-wire-format.md))

### `client/Application`

- Next.js 16
- ポート `13001`
- route group で管理者向け UI と参加者向け UI を同居
- GameDay / Battle / Rankings / Profile の画面を持つ

## 4. バックエンド構成

主要サービスと想定ポートは以下のとおりです。

| サービス | 役割 | ポート |
|---|---|---|
| tenant-management | テナント CRUD と状態管理 | `13004` |
| problem-service | 問題・イベント関連 API | `3100` |
| gameday-service | GameDay API | `3020` |
| battle-service | Battle API | 実装依存 |
| scoring-service | 採点処理 | 実装依存 |
| leaderboard-service | ランキング API | 実装依存 |

Hono ベースのサービスが多く、ルートの `package.json` の `dev` スクリプトから同時起動されます。

## 5. データと共有層

### 共有コード

- `server/libs/dynamodb` — DynamoDB クライアント、リポジトリ層、tenant context / isolation middleware
- `server/libs/events` — EventBridge 型定義 (TenantOnboarding / Provisioned / Updated / Offboarding)
- `server/libs/auth` — JWT 検証、JWKS、role 抽出 (NextAuth v5 / Cognito / Auth0 互換)
- `packages/shared` — quality harness 検出ロジックなどのプラットフォーム共有
- `packages/design-system` — UI コンポーネント (Cloudscape ラッパー)

### データストア

現行のローカル開発では DynamoDB 互換のローカルエミュレータを使用します。problem-service は Prisma を含みますが、リポジトリ全体の唯一のデータ前提としては固定していません。各サービスの実装を優先してください。

Control Plane と Application Plane の正本アーキテクチャは serverless only です。tenant runtime や platform runtime に `ECS`, `EKS`, `RDS`, `NAT Gateway` を持ち込まない方針を採ります。

## 6. 認証

- 本番相当: Auth0
- ローカル簡易確認: `AUTH_SKIP=1`

以下は正本から外します。

- Keycloak 前提
- Cognito 前提
- NextAuth.js v4 前提の記述

## 7. ローカル実行モデル

`make start` は以下の責務をまとめます。

1. ローカルエミュレータを起動
2. 必要な AWS 互換リソースを初期化
3. フロントエンド 2 アプリを起動
4. 主要バックエンドサービスを起動
5. 認証スキップ用の環境変数を注入

主要 URL は以下のとおりです。

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`
- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`

## 8. ドキュメントの読み方

仕様を把握するときの優先順位は以下のとおりです。

1. `client/{AdminWeb,Application}/` と `server/microservices/*/src/` の実装
2. この文書
3. `docs/QUICKSTART.md`
4. `docs/decisions/*` (特に最新の ADR-013 / ADR-014)
5. `Plan.md` と `docs/plans/*`

`Plan.md` と `docs/plans/*` は履歴や構想が混ざるため、現在仕様の正本には使いません。

アーキテクチャの境界やワンパス完了条件を判断するときは、必ず [`docs/architecture/harness.md`](./harness.md) を参照します。
