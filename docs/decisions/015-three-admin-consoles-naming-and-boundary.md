# ADR-015: Three Admin Consoles — Naming and Boundary

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: susumutomita

## Context

ユーザーからの観察:「admin 系の画面が `client/AdminWeb` と `client/Application` の両方に分散していて何がどこにあるか分からない」。実際に route を棚卸しすると、**3 種類の admin 体験** が 1 つの `(admin)` route group に同居していた。

| 体験 | ロール | 時間軸 | スコープ |
|---|---|---|---|
| プラットフォーム運営 | platform admin (テナント運営者) | tenant ライフサイクル全体 | 全テナント横断 |
| イベント企画・準備 | tenant admin | event 開催前〜終了後 | tenant 全体 |
| 競技中の運営オペ | tenant admin (or event organizer) | 1 event の active 中心 | 1 event |

route 上の現状 (PR #416 後) は以下のとおり。

- `client/AdminWeb/app/dashboard/tenants/*` … プラットフォーム運営 (basePath=/control, NextAuth + Cognito の PLATFORM_ADMIN role)
- `client/Application/app/(admin)/admin/{events,problems,participants,teams,marketplace,settings,analytics}` … 一部 event 単体に閉じない情報と event 単体に閉じる情報が混在
- `client/Application/app/(admin)/admin/events/[eventId]/*` および `gameday/[eventId]/*` … 1 event の運営オペ

混在の弊害は以下のとおり。
- 「event を新規作成する権限」と「ある event のスコアを止める権限」が同じ admin role に丸められやすい
- nav 設計でモードレス・モードフルの行き来が起きやすい (event を選んでから operate / event を選ばずに operate を読み分けにくい)
- API 認可と URL 設計の単位が分かれない (今は `/api/admin/events/...` がほぼ全部入り)

## Decision

### 1. 3 つの console を概念として固定する

| Console 名 | 対象ユーザー | スコープ | デフォルト ID/ロール |
|---|---|---|---|
| **Tenant Admin Console** | platform admin | 全テナント横断 | Cognito (Control Plane), `PLATFORM_ADMIN` |
| **Application Admin Console** | tenant admin | 1 tenant の全 event とライブラリ | NextAuth (Application Plane), `TENANT_ADMIN` |
| **Event Admin Console** | tenant admin / event organizer | 1 event のオペ (active 中心) | 同上 + event-scoped path で限定 |

### 2. 物理的なアプリ分割は行わない (2 Next.js apps を維持)

| Console | 物理的な home |
|---|---|
| Tenant Admin | **`client/AdminWeb`** (basePath=`/control`) ── このアプリは Tenant Admin 専有とする |
| Application Admin | `client/Application` の `(admin)/admin/*` のうち **event-scoped でない** route |
| Event Admin | `client/Application` の `(admin)/admin/*` のうち **event-scoped (`[eventId]` を含む)** route |

3 アプリに分けない理由は以下のとおり。
- Event Admin は常に Application Admin から遷移してくる (event 一覧 → event 個別)。share した tenant-level state (auth, role, tenant context, tenant theme) を毎回再ロードする利点がない。
- Application Plane は ADR-011 で `INVARIANT_ONE_APPLICATION_PLANE_PER_TENANT` のため tenant ごとに 1 deploy。これを更に 2 deploy に割ると tenant 数 × console 数の運用コストが乗る。
- ヘッダ/ナビゲーション/通知が共通な以上、route group + layout 分離で論理境界を作るほうがコスト効率が高い。

### 3. Application Admin と Event Admin の route 境界

`client/Application/app/(admin)/admin/` 配下を以下のとおり再分類する。

**Application Admin Console (tenant-wide)**

- `events/` (一覧)、`events/new` (作成)
- `problems/`, `problems/new`, `problems/[id]/edit`, `problems/[id]/deploy` (problem ライブラリ管理)
- `participants/`
- `teams/`
- `marketplace/`
- `settings/`
- `analytics/`

**Event Admin Console (event-scoped)**

- `events/[eventId]/` (event 詳細・運営トップ)
- `events/[eventId]/edit`
- `events/[eventId]/attacks`
- `events/[eventId]/problems/`, `events/[eventId]/problems/[problemId]/`, `events/[eventId]/problems/[problemId]/deployments`
- `gameday/[eventId]/`, `gameday/[eventId]/dashboard`, `gameday/[eventId]/report`

実装上の表現は以下のとおり。

```
client/Application/app/(admin)/admin/
├── (application-admin)/      ← Application Admin Console route group
│   ├── events/page.tsx       ← 一覧
│   ├── events/new/page.tsx
│   ├── problems/...
│   ├── participants/...
│   ├── teams/...
│   ├── marketplace/...
│   ├── settings/...
│   └── analytics/...
└── (event-admin)/            ← Event Admin Console route group
    ├── events/[eventId]/...
    └── gameday/[eventId]/...
```

route group `(application-admin)` / `(event-admin)` は URL に出ない (Next.js の慣例)。それぞれに専用 layout を置き、ナビ・パンくず・タイトル帯で「今どの console にいるか」を視覚化する。

### 4. role / 認可の境界

- **Tenant Admin Console**: `PLATFORM_ADMIN` のみ。`tenant_id` クレームを必要としない (全テナント横断)。
- **Application Admin Console**: `TENANT_ADMIN` 必須。リクエストの `tenant_id` クレームと URL 上の tenant context が一致すること。
- **Event Admin Console**: 上記に加え、`eventId` で対象 event を取得し、その event が同じ tenant に所属していることをハンドラ側で検証。event ごとの追加 role は導入しない (将来必要になれば別 ADR で `EVENT_ORGANIZER` を新設)。

### 5. API ルートの整理方針 (本 ADR では宣言のみ、実装は別 PR)

| 旧 | 新 (案) |
|---|---|
| `/api/admin/events` | `/api/application-admin/events` |
| `/api/admin/events/[eventId]/...` | `/api/event-admin/events/[eventId]/...` |
| `/api/admin/problems` | `/api/application-admin/problems` |
| `/api/admin/participants` | `/api/application-admin/participants` |

互換のため旧 `/api/admin/*` は当面 alias 残置 (3 リリース猶予を取り、別 PR で削除)。

### 6. ナビゲーション

- Application Admin と Event Admin はサイドバー・ナビの構造を分ける。
- Event Admin に入ると、グローバルナビは Event 名を含むパンくずを冒頭に固定し、Application Admin に戻る導線を必ず入れる。
- Tenant Admin は別 hosting (`client/AdminWeb`) なのでアプリ間のフルページ遷移として明示する。

## Consequences

- **Good**:「どこを触ると何が壊れるか」が role / 時間軸 / スコープで一意に説明できるようになる。新規参加者が `(admin)/admin/*` を読むときの認知負荷が下がる。
- **Good**: API 認可の単位が console と揃うので、`/api/event-admin/...` に event ownership ガードを差し込むだけで済む。
- **Good**: nav layout 単位で実装するので、3 アプリ deploy を増やさずに UI/UX 上の境界を立てられる。
- **Bad**: 既存ファイルの route group 移動 (主に `client/Application/app/(admin)/admin/` 配下) と関連テストの import 修正が発生する。1 PR では大きいので段階移行する。
- **Bad**: `/api/admin/*` の alias を残す期間は二重メンテになる (削除 PR まで 3 リリース猶予)。
- **Tradeoff**: 物理的な 3 アプリ分割は採らない。OpenNext 移行時に「Tenant Admin だけ Lambda、Application Plane は別戦略」のような hosting 別最適化は **2 アプリ単位** までに留める。

## Migration Plan (別 PR で段階実施)

1. **Phase A (本 PR)**: 本 ADR を accept。実装は触らない。
2. **Phase B**: `client/Application/app/(admin)/admin/` 配下を `(application-admin)` / `(event-admin)` route group に物理分離。layout を分ける。テスト import 更新。
3. **Phase C**: API ルート `/api/admin/*` を `/api/application-admin/*` / `/api/event-admin/*` に再配置 (旧 alias 残置)。サーバー側で event ownership ガード追加。
4. **Phase D (3 リリース後)**: 旧 `/api/admin/*` alias を削除。

各 Phase は単独で revert 可能であること。

## References

- [ADR-007: マルチテナント分離戦略](./007-tenant-isolation-strategy.md)
- [ADR-009: Application Admin Isolation and AWS Deployment Engine](./009-application-admin-isolation-and-aws-deployment-engine.md)
- [ADR-011: SBT Control Plane と二層 Application Plane 構成](./011-sbt-control-plane-and-two-layer-application-plane.md)
- [ADR-013: SBT Control Plane Onboarding Wire Format](./013-sbt-control-plane-onboarding-wire-format.md)
- [ADR-014: Repository Layout — CDK out of server/](./014-repository-layout-cdk-out-of-server.md)
- 関連コード: `client/AdminWeb/app/dashboard/tenants/*`, `client/Application/app/(admin)/admin/*`
