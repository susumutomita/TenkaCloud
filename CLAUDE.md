# TenkaCloud

AWS マルチテナント SaaS のクラウドコンペティション基盤。問題は **Battle**（リアルタイム対戦）と **Challenge**（個別演習・常設チャレンジ）の 2 カテゴリで配信する (旧称 GameDay / JAM)。SBT (`@cdklabs/sbt-aws` 0.3.9) を土台に、Control Plane / Application Plane / 競技者 AWS アカウントへの問題 deploy をまるごと CDK で持つ。

## アーキテクチャ

```
TenkaCloud/
├── apps/                                    # Vite + React 19 + Cloudscape の SPA 群
│   ├── admin-console/                       # System Admin 用 Control Plane UI (dev :5173)
│   ├── application-admin-console/           # Tenant Admin 用 Application Plane UI (dev :5174)
│   └── participant-portal/                  # 競技者向けポータル (dev :5175)
├── infrastructure/                          # CDK (SBT 0.3.9) — 全 backend は Lambda
│   ├── bin/infrastructure.ts                # Stack 配線のエントリ
│   ├── lib/
│   │   ├── control-plane-stack.ts           # SBT ControlPlane (Cognito + EventBridge + API)
│   │   ├── bootstrap-template/              # Tenant pipeline 用 bootstrap (TenantMappingTable)
│   │   ├── tenant-template/                 # 1 tenant 分の API + Cognito + ApplicationConsole hosting
│   │   ├── tenant-pipeline/                 # CodePipeline 経由の per-tenant provisioning
│   │   ├── problem-deploy/                  # 競技者 AWS への問題 deploy (DDB + Worker Lambda + API)
│   │   ├── admin-console-hosting.ts         # admin-console を S3+CloudFront 配信
│   │   ├── cdk-aspect/                      # DynamoDbLowCapacity / DestroyPolicySetter
│   │   ├── config/                          # config.json schema + interface
│   │   └── utils/                           # config-loader, iam-helpers
│   ├── environments/<env>/{config.json,.env}# 環境別設定。.env で ${VAR:-default} を注入
│   └── templates/competitor-bootstrap.yaml  # 競技者アカウント側で 1 回流す IAM Role
├── scripts/                                 # install.sh / cleanup.sh / provision-tenant.sh 等
├── problems/<category>/<id>/                # 1 ディレクトリ 1 問題 (metadata.json + template.yaml)
└── .github/workflows/ci.yml                 # PR で lint / typecheck / test / build
```

### Plane 配置

- **Control Plane** (`ControlPlaneStack`) — SBT 内蔵の Cognito UserPool + System Admin + Tenant CRUD API + EventBridge bus。`admin-console` がフロント。
- **Application Plane (pooled)** — `serverless-saas-ref-arch-tenant-template-pooled` として Phase 1 で 1 つ立つ。BASIC / STANDARD / PREMIUM tier の tenant が共有する `application-admin-console` を 1 CloudFront URL で配信。
- **Application Plane (silo)** — PLATINUM tier の tenant 作成イベントで `ServerlessSaaSPipeline` が CodeBuild を起動し、tenant 専用の `serverless-saas-ref-arch-tenant-template-<tenantId>` を deploy。
- **Problem deploy backend** (`ProblemDeployBackendStack`) — Deployments DDB + Cognito JWT 認可付き HTTP API + Worker Lambda。EventBridge から `DeployRequested` を拾い、tenant の ExternalId で競技者アカウントへ AssumeRole → CFn CreateStack。
- **Participant Portal** — 競技者が自チームの問題エンドポイント・スコアを見るアプリ。`ProblemDeployBackendStack` から S3+CloudFront でホスティング (有効化は `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true`)。

### Plane 越しの通信

EventBridge bus (Control Plane が払い出し、ARN を `bin/infrastructure.ts` で他 stack に渡す) を経由する。フロントエンドは runtime-config.json + Cognito JWT で各 API を叩く。

### データ分離

DynamoDB シングルテーブル設計はしない。stack ごとに専用テーブル (TenantMappingTable / Deployments / Apps 等) を持ち、テナント分離は `TenantId` キー or stack 自体の分離で行う。**全テーブルは PROVISIONED 1 RCU / 1 WCU を Aspect (`DynamoDbLowCapacity`) で強制** — Free Tier 25 RCU/WCU 内に収めるため。

## コマンド

| コマンド                | 用途                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `make install`          | 全 workspace の依存をインストール (bun)                     |
| `make build`            | 全 workspace を build (`infrastructure` → 3 SPA)            |
| `make typecheck`        | 全 workspace の `tsc --noEmit`                              |
| `make test`             | 全 workspace の vitest                                      |
| `make lint`             | markdownlint + textlint + biome                             |
| `make fix`              | 上記の自動修正版 (`make format` でも可)                     |
| `make validate-problems`| `problems/**/metadata.json` を `problems/SCHEMA.json` で検証|
| `make check`            | install + lint + test + validate-problems                   |
| `make before-commit`    | lint + test + validate-problems (PR 前の必須ゲート)         |
| `make synth`            | `cdk synth` (デフォルト `ENV=development`)                  |
| `make diff`             | `cdk diff --all`                                            |
| `make bootstrap`        | `cdk bootstrap`                                             |
| `make deploy`           | `scripts/install.sh` を起動 (3-phase deploy)                |
| `make destroy`          | `scripts/cleanup.sh` で全 stack + S3 を冪等に破棄           |
| `make harness`          | architecture invariant チェック (`docs/architecture/harness.md`) |
| `make harness-test`     | harness 自体のユニットテスト (`.claude/harness/`)           |
| `make tech-debt`        | 技術的負債スキャン (test smell / 結合 / 責務漏れ)           |
| `make help`             | Makefile の全ターゲット一覧                                 |

環境切替は `make deploy ENV=production` のように `ENV` 変数で行う。`infrastructure/environments/<env>/.env` を読み込み、無ければ `make env-check` がエラーで止める。

## アーキテクチャ Invariants

`docs/architecture/harness.md` に固定済み。`make harness` が `.claude/harness/bin/architecture.ts` で staged ファイルを検査して逸脱を error で報告する。

| ID                                                    | 概要                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `INVARIANT_CONTROL_PLANE_USES_SBT`                    | Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる         |
| `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`| Control Plane は tenant manager。tenant runtime を持ち込まない                  |
| `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER`           | テナント分離はインフラ層 (DDB PK / stack 分離) で実現。アプリに tenant ロジックを書かない |
| `INVARIANT_APP_CODE_IS_UNMODIFIED`                    | `apps/*/dist/` は tenant 共有。差分は `runtime-config.json` 経由で注入する       |
| `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`              | 認証はインフラ層で注入。アプリに `AUTH_SKIP` 的なバイパスを書かない              |
| `INVARIANT_PR_SHIPS_WORKING_INCREMENT`                | PR 単体で観察可能な機能が動く。scaffolding-only PR は禁止                        |
| `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`              | コード変更とテストを同じ PR に含める。既存テストでカバー時は body で明示         |
| `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED`         | PR body に `## Regression 分析` セクションで壊しうる挙動を列挙する              |
| `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED`             | PR body に `## 物理影響` セクションで CFn / 成果物の差分を CREATE/UPDATE/REPLACE/DELETE/NO-OP で列挙 |
| `ONE_PASS_LOCAL`                                      | ローカルで tenant 作成 → application console → 問題 deploy → participant join がブラウザ 1 回で通る |
| `ONE_PASS_AWS`                                        | `make deploy` 1 発で 3-phase が通り、SystemAdmin 招待 → tenant 作成 → 問題 deploy → 競技者ログインまで一気通貫 |

加えて次の Enforcement Rules を機械検査する。

- `secrets-manager-forbidden` — `@aws-sdk/client-secrets-manager` 禁止 (SSM Parameter Store SecureString を使う、コスト 0 原則)
- `handler-must-not-call-fetch` — `lib/handlers/` で `fetch(` 直接呼び出し禁止 (Service / Repository に閉じ込める)

## 開発フロー

### ゲート (PR 作成前)

1. `make harness` — architecture invariant 違反が 0 件であること
2. `make before-commit` — lint / typecheck / test / build / validate-problems がすべて通ること
3. `/review` — コードレビュー
4. `/security-review` — セキュリティレビュー
5. `/simplify` — 重複・複雑度・無駄なコードの最終チェック

すべて通るまで未完了。失敗したら原因を特定してコードを修正する（`biome.json` / `vitest.config.ts` 等の設定ファイルを直接いじらない）。

### 利用可能な skills

`.claude/skills/` 配下に置いてある。`/<skill-name>` で起動する。

| skill              | 用途                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `/harness`         | `make harness` を走らせて architecture invariant 違反を検出                 |
| `/tech-debt`       | `make tech-debt` で技術的負債バックログを生成（assertion-roulette / 結合 / fallback 検出） |
| `/create-problem`  | `problems/<category>/<id>/` を `metadata.json` + `template.yaml` 規約で雛形生成 |
| `/spec`            | Open Web Docs (MDN) スタイルの技術仕様書を書く                              |

### TDD

テストを先に書く。テストタイトルは日本語「〜すべき」形式。Vitest は workspace ごとに独立 (`infrastructure/vitest.config.ts`、各 SPA の `vite.config.ts`)。

```typescript
describe("AdminConsoleHostingStack", () => {
  it("CloudFront distribution に runtime-config.json が配置されるべき", () => {
    // ...
  });
});
```

### Issue 引用ルール

コミットや PR 本文で `#番号` 形式は使わない（auto-close されてしまうので）。代わりに `(PR-F1)` `(#446)` のようにスペース区切りや別記法で指す。

### HTTP status code は magic number 禁止

`c.json(body, 500)` のような数値リテラル直書きは禁止です。`http-status-codes` の `StatusCodes` enum を使ってください。

```ts
import { StatusCodes } from "http-status-codes";

return c.json({ ok: true }, StatusCodes.OK);                    // ✅
return c.json({ error: "..." }, StatusCodes.INTERNAL_SERVER_ERROR);  // ✅
return c.json({ ok: true }, 200);                               // ❌ magic number
```

フロントエンドの fetch response 判定も同様です。

```ts
if (res.status === StatusCodes.UNAUTHORIZED) throw new PortalAuthError();  // ✅
if (res.status === 401) throw new PortalAuthError();                       // ❌
```

旧来の `HTTP_OK` / `HTTP_INTERNAL_ERROR` は `infrastructure/lib/problem-deploy/handlers/shared/http-status.ts` に deprecated alias として残ります。新規コードでは使いません。値は `StatusCodes.*` から派生するため、library 更新で自動追従します。

## 禁止事項

- **`npx` 禁止** → `bunx` または `nlx` を使う
- **`rm` コマンド禁止** → ファイル削除は `git rm` 経由で扱う
- **HTTP status code の数値リテラル直書き禁止** — `StatusCodes.*` (`http-status-codes` library) を使う
- **モック / スタブで握り潰す fallback 禁止** — 失敗するなら明示的に失敗させる
- **DynamoDB を on-demand (PAY_PER_REQUEST) で立てない** — `DynamoDbLowCapacity` Aspect で 1/1 PROVISIONED に強制している。これを破る変更は CFn 出力で必ず引っかかる
- **設定ファイル (`biome.json`, 各 `vitest.config.ts`, `tsconfig.json`) の直接変更禁止** — コード側を修正する
- **シークレット (`.env`, AWS credentials) のコミット禁止** — `.gitignore` で除外、`infrastructure/environments/<env>/.env.example` だけコミット

## セキュリティ

- ユーザー入力 / 外部 API 境界では Zod でバリデーション
- 認証バイパスを実装しない (本 repo には AUTH_SKIP は無い、Cognito JWT を必ず通す)
- `innerHTML` / `eval` / `dangerouslySetInnerHTML` 不使用
- 競技者アカウントへの AssumeRole は **必ず ExternalId** を要求 (`CDK_PARAM_DEPLOY_EXTERNAL_ID`)
- `infrastructure/templates/competitor-bootstrap.yaml` の IAM Role は最小権限 (CFn CreateStack + 問題テンプレートが触る AWS サービス分のみ)
- 依存パッケージは Renovate / dependabot で更新、CI は Safe Chain で malicious package を検出

## 技術スタック

| レイヤー         | 技術                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| フロントエンド   | Vite 7, React 19, react-router 7, Cloudscape Design System            |
| バックエンド     | AWS Lambda (Node.js / Hono on Lambda), API Gateway HTTP API           |
| IaC              | AWS CDK 2 + `@cdklabs/sbt-aws` 0.3.9, cdk-nag                         |
| 認証             | AWS Cognito (Hosted UI + OAuth Code + PKCE)                           |
| データ           | DynamoDB (PROVISIONED 1/1 強制)                                       |
| イベント         | EventBridge (cross-plane: tenant 作成 / DeployRequested / DeployCompleted) |
| テスト           | Vitest                                                                |
| Lint / Format    | Biome (TS), markdownlint-cli2 + textlint (Markdown)                   |
| パッケージ管理   | Bun 1.3.11 (workspaces: `infrastructure` + `apps/*`)                  |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                           |

## デプロイの流れ

`make deploy` (= `scripts/install.sh`) は次の 3 フェーズで動く。

1. **Phase 1**: `ControlPlaneStack` + `serverless-saas-ref-arch-bootstrap-stack` + `serverless-saas-ref-arch-tenant-template-pooled` + `ServerlessSaaSPipeline` を deploy。CORS/callback は localhost のみ。
2. **Phase 2**: Phase 1 の outputs を runtime-config 用 env に入れて `apps/admin-console` を host で build → `AdminConsoleHostingStack` (S3 + CloudFront) を deploy。
3. **Phase 3**: CloudFront URL を `CDK_PARAM_ADMIN_CONSOLE_ORIGIN` に入れて `ControlPlaneStack` を再 deploy → callback / CORS を更新。

teardown は `make destroy` (= `scripts/cleanup.sh`)。途中失敗状態 / 部分削除済み状態からも冪等に動くよう書かれている。

## ポインター

- **アーキテクチャ正本**: [`docs/architecture/harness.md`](./docs/architecture/harness.md) — invariant + PR Discipline
- **デザインシステム**: [Cloudscape](https://cloudscape.design/components/) — UI コンポーネントは原則ここから選ぶ
- **問題作成**: [`problems/README.md`](./problems/README.md) (metadata.json スキーマ + template.yaml 規約) — `/create-problem` で雛形生成
- **競技者側セットアップ**: [`infrastructure/templates/README.md`](./infrastructure/templates/README.md)
- **エージェント向けガイド**: @AGENTS.md
- **コントリビューション**: @CONTRIBUTING.md
