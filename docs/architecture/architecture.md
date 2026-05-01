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

- Next.js 16 (`output: 'export'` static export、cloud では CloudFront ルート配信、ローカル dev では `basePath=/control`)
- ポート `13000` (ローカル)
- 主に `/dashboard/*` 配下でプラットフォーム管理を提供
- 認証は **browser-side Cognito PKCE** (本番) / `AUTH_SKIP=1` (ローカル)。NextAuth は PR #420 で撤去済み
- 起動時に `/runtime-config.json` を fetch して URL (`apiUrl` / `cognitoDomain` / `userClientId` / `adminApiUrl`) を解決し、build artifact を環境非依存に保つ
- SBT control plane API は `lib/api/sbt-api-adapter.ts` 経由でテナント CRUD (詳細は [ADR-013](../decisions/013-sbt-control-plane-onboarding-wire-format.md))
- 各 microservice には `lib/api/admin-api-client.ts` の `adminFetch()` 経由でアクセスし、Cognito ID token を `Authorization: Bearer` で添付

### `client/Application`

- Next.js 16
- ポート `13001`
- route group で管理者向け UI と参加者向け UI を同居
- GameDay / Battle / Rankings / Profile の画面を持つ

## 4. バックエンド構成

主要サービスと想定ポートは以下のとおりです。

| サービス | 役割 | ローカルポート | Lambda 化 (PR #422) |
|---|---|---|---|
| tenant-management | テナント CRUD と状態管理 | `13004` | ✅ |
| problem-service | 問題・イベント関連 API | `3100` | ✅ |
| gameday-service | GameDay API | `3020` | ✅ |
| battle-service | Battle API | `3010` | ✅ |
| scoring-service | 採点処理 | `3011` | ✅ |
| leaderboard-service | ランキング API | `3012` | ✅ |

各サービスは Hono で実装され、ローカル開発では `make start` から同時起動されます。AWS deploy では各サービスを `bun build src/lambda.ts --target node` で 1 ファイルに bundle し、`hono/aws-lambda` adapter 経由で Lambda 関数として動作します。

### AdminApiStack (cloud)

PR #422 で追加された `infrastructure/cdk/lib/admin-api-stack.ts` が、AdminWeb (CloudFront) から各 microservice (Lambda) への呼び出しを集約します。

```text
AdminWeb (CloudFront, static export)
   │
   │ adminFetch('tenant-management', '/api/stats', ...)
   │  + Authorization: Bearer <Cognito id_token>
   ▼
HTTP API Gateway  ──Cognito JWT Authorizer──▶ Lambda
   /tenant-management/{proxy+}                  各 service の lambda.handler
   /problem/{proxy+}
   /gameday/{proxy+}
   /battle/{proxy+}
   /scoring/{proxy+}
   /leaderboard/{proxy+}
```

セキュリティ設計は以下のとおりです。

1. **API Gateway Cognito JWT Authorizer** が Lambda 起動前に JWT を検証する。token 無し / 無効な request は Lambda に到達しない。`/health` のみ authorizer 無し (CloudWatch synthetics 用)。
2. **各 Lambda は個別の IAM Role** を持ち、共有 DynamoDB テーブルの R/W のみ許可される。`lambda:InvokeFunction` 権限は一切付与しないため、service-to-service の直接 invoke は **不可能**。service 間で通信する必要が生じた場合は API Gateway 経由の HTTP 呼び出しか EventBridge を使う。
3. **CORS** は AdminConsole CloudFront origin と localhost dev origin のみ許可 (`*` 不可、`allowCredentials: false`)。
4. **Hono の auth-middleware** が application 層で再度 JWKS 検証する (defense-in-depth)。

DynamoDB は ADR-007 の single-table design (PK/SK + GSI1)、PROVISIONED 1/1 (dev)。

## 5. データと共有層

### 共有コード

- `server/libs/dynamodb` — DynamoDB クライアント、リポジトリ層、tenant context / isolation middleware
- `server/libs/events` — EventBridge 型定義 (TenantOnboarding / Provisioned / Updated / Offboarding)
- `server/libs/cloud-abstraction` — local emulator (LocalStack/Kumo) と AWS 本番を隔てる薄いラッパ
- `packages/shared` — quality harness 検出ロジックなどのプラットフォーム共有
- `packages/core` — AWS / scoring 関連の純粋ロジック
- `packages/design-system` — UI コンポーネント (Cloudscape ラッパー)

> JWT 検証は各 microservice が個別に持つ `src/middleware/auth.ts` が `jose` で行います。共通化された `server/libs/auth` は無く、cloud では AdminApiStack が各 Lambda の env に `JWKS_URI` / `JWT_ISSUER` / `JWT_AUDIENCE` を注入します。

### データストア

現行のローカル開発では DynamoDB 互換のローカルエミュレータを使用します。problem-service は Prisma を含みますが、リポジトリ全体の唯一のデータ前提としては固定していません。各サービスの実装を優先してください。

Control Plane と Application Plane の正本アーキテクチャは serverless only です。tenant runtime や platform runtime に `ECS`, `EKS`, `RDS`, `NAT Gateway` を持ち込まない方針を採ります。

## 6. 認証

- **本番**: AWS Cognito (SBT 0.3.9 が UserPool / Hosted UI を作成)
  - AdminWeb は browser-side **PKCE flow** で `id_token` を取得し、`localStorage` に保持
  - API Gateway の **Cognito JWT Authorizer** が Lambda 起動前に検証
  - 各 Lambda の Hono `auth-middleware` も JWKS で再検証 (defense-in-depth)
- **ローカル簡易確認**: `AUTH_SKIP=1` + `NEXT_PUBLIC_AUTH_SKIP=1` (本番ガード `NODE_ENV !== 'production'` 必須)

以下は正本から外します (履歴的に存在したが現行コードでは使わない)。

- Auth0 / NextAuth.js — PR #420 で撤去
- Keycloak 前提

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
