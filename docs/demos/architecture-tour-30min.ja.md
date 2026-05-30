# 30 分の技術評価者向けアーキテクチャツアー

> English: [architecture-tour-30min.md](./architecture-tour-30min.md)

これは CCoE / プラットフォームチーム評価者向けの技術深掘りパスです。 5 分の quickstart は視聴済み、 もしくは [`docs/demos/quickstart-5min.ja.md`](./quickstart-5min.ja.md) を読了済みである前提です。 想定時間 : ファシリ込みで約 30 分。

## オープニング (約 2 分)

枠を設定します。 TenkaCloud は `@cdklabs/sbt-aws` 0.3.9 上に構築され、 4 つの plane が EventBridge bus で通信します。 各 plane → セキュリティ → マルチクラウドロードマップの順に歩きます。

**事前読み物**。

- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10 分の overview
- [`docs/architecture/MODULE_MAP.md`](../architecture/MODULE_MAP.md) — ディレクトリ → モジュール index
- [`docs/architecture/GLOSSARY.md`](../architecture/GLOSSARY.md) — 用語定義 + ADR バックリンク

## Plane 1 — Control Plane (約 5 分)

**対象ファイル**。 `infrastructure/lib/control-plane-stack.ts`

**トークポイント**。

- Control Plane は SBT の `ControlPlane` construct をラップする。 Cognito UserPool / Tenant CRUD API / EventBridge bus は再実装しない — それは SBT 契約。 `docs/architecture/harness.md` の `INVARIANT_CONTROL_PLANE_USES_SBT` 参照。
- Control Plane は **テナント管理者** であって、 テナントランタイムではない。 テナントランタイムデータをここに置くと `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` 違反となり、 PR レビューで `make harness` が失敗する。
- `admin-console` (Vite + React 19 + Cloudscape) が System Admin UI。 boot 時に `runtime-config.json` を fetch し、 Cognito JWT で Tenant CRUD API を呼ぶ。

**ADR 参照**。

- `ADR-018` — Pooled UserPool SAML 分離 (テナント identity の namespacing)
- `ADR-020` — 認可モデル (claim 形状、 scope ルール)

**確認テクニック**。 `make synth` を実行して `ControlPlaneStack` リソースを grep すれば SBT 配線の健全性を確認できます。

## Plane 2 — Application Plane (約 5 分)

**対象ファイル**。

- `infrastructure/lib/tenant-template/` — テナント 1 つの API + Cognito + UI ホスティング
- `infrastructure/lib/tenant-pipeline/` — CodePipeline 経由のテナント別 provisioning (PLATINUM tier のみ)
- `infrastructure/lib/bootstrap-template/` — `TenantMappingTable` (どのテナントがどの tier か)

**トークポイント**。

- Pooled tier (BASIC / STANDARD / PREMIUM) は **1 つ** の `serverless-saas-ref-arch-tenant-template-pooled` stack を共有。 テナント行は `TenantId` で partition された DynamoDB に存在。 これが最も安いモデル。
- PLATINUM tier は `ServerlessSaaSPipeline` を起動し、 CodeBuild で専用 `serverless-saas-ref-arch-tenant-template-<tenantId>` を build。 この stack は他テナントから隔離された専有 stack — 別 Cognito、 別 DDB、 別 Application Console URL。
- フロントエンド `application-admin-console` は全 tier で **同じ dist**。 差分は `runtime-config.json` で実行時に注入。 これが `INVARIANT_APP_CODE_IS_UNMODIFIED` : アプリ成果物はテナント ID で分岐しない。

**ADR 参照**。

- `ADR-004` — Event-team データモデル
- `ADR-016` — TenkaCloud Lite App Plane Core (Lite mode が使う `tenantId="local"` 単純化)
- `ADR-019` — クロスアカウント stack カタログ

## Plane 3 — Problem Deploy Backend (約 5 分)

**対象ファイル**。

- `infrastructure/lib/problem-deploy/` — Deployments DDB + Worker Lambda + 採点 dispatcher + JWT 認証 HTTP API
- `infrastructure/templates/competitor-bootstrap.yaml` — 競技者アカウントで 1 度だけ実行する CFn

**トークポイント**。

- Worker Lambda は EventBridge bus の `DeployRequested` イベントを subscribe。 発火するとテナントの `ExternalId` (必須 / opt out 不可) で competitor アカウントへ AssumeRole し、 問題の `template.yaml` で CFn `CreateStack` を実行。
- 採点は 1 本の Lambda に集約し、 `kind` で dispatch。 5 種は `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`。 **プラットフォーム側に問題固有コードは置かない** — `ADR-012`。
- Reconciliation は EventBridge 駆動 (`ADR-014`)。 フロントエンドは polling (SSE は使わない — `AGENTS.md`)、 EventBridge は polling を補強するので long-lived socket は不要。
- Worker Lambda は Step Functions が前段に立ち、 retry / delete のオーケストレーションを担う。 idempotency は state を `(tenantId, eventId, teamId, problemId)` で key 化して保つ。

**ADR 参照**。

- `ADR-001` — Problem deploy CRUD モデル
- `ADR-002` および `ADR-009` — クロスアカウントフェデレーション
- `ADR-012` — 問題プラグインアーキテクチャ (プラットフォームの中心)
- `ADR-013` — Disruption phase 2 (条件起動の phase 進行)
- `ADR-014` — EventBridge 駆動の state reconciliation
- `ADR-017` — Cloud Action インテント / Trust Bridge

## Plane 4 — Participant Portal (約 4 分)

**対象ファイル**。

- `apps/participant-portal/` — Vite + React 19 + Cloudscape SPA
- `infrastructure/lib/problem-deploy/` (Participant Portal hosting は `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true` で有効)

**トークポイント**。

- ポータルは team の Cognito UserPool 経由で参加者をログインさせる。 ログイン後、 team が deploy 済みの問題 / endpoint / flag / disruption phase を fetch。
- ワンクリック AWS Console SSO は、 team の読み取り専用 `ParticipantViewerRole` への federation で実装 (scoping IAM 文は各問題の `template.yaml` 参照)。
- チーム間 coordination (router 更新 / 同盟 / 共有リソース queue) は **プラットフォームに焼き込まない**。 問題の `portal/` プラグインへ dispatch する (`ADR-028`)。 プラットフォームは primitive を提供し、 意味論は問題が所有する。

**ADR 参照**。

- `ADR-005` — Battle Portal UI
- `ADR-006` — Notifications
- `ADR-028` — Inter-team coordination plugin

## セキュリティポスチャー (約 5 分)

**トークポイント**。

- **AssumeRole は常に `ExternalId` 必須**。 CDK パラメータ `CDK_PARAM_DEPLOY_EXTERNAL_ID` は省略不可。 competitor アカウントは `(TenkaCloud platform account, ExternalId)` のみ信頼する role でブートストラップ。
- **bootstrap CFn は least privilege**。 `infrastructure/templates/competitor-bootstrap.yaml` は CFn CreateStack と各問題テンプレートが触れる AWS サービスの和集合のみ付与。 問題が god mode role をもらうことはない。
- **認可は infra 層で注入、 アプリ層ではやらない**。 リポジトリのどこにも `AUTH_SKIP` は存在しない (`INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`)。 すべてのリクエストは API Gateway で Cognito JWT 検証を通る。
- **テナント分離は stack 分離 + DDB partition key**。 single-table のクロステナント設計は使わない。 Pooled tier は stack 共有 + `TenantId` partition、 PLATINUM tier は専用 stack。
- **サプライチェイン防御 (mini Shai-Hulud 2nd wave)**。 4 層 : Bun の `trustedDependencies` 空 allowlist、 `.npmrc` で `ignore-scripts=true` + 7 日間 quarantine、 `make audit-deps` が CI で baseline diff、 `make install_ci` が `--ignore-scripts` + Aikido Safe Chain。
- **on-demand DynamoDB は禁止**。 CDK Aspect `DynamoDbLowCapacity` が全テーブルを 1 RCU / 1 WCU PROVISIONED に強制。 レビュー規律ではなく construction レベルで Free Tier safe。
- **`@aws-sdk/client-secrets-manager` 禁止**。 SecureString は SSM Parameter Store のみ。 `make harness` の `secrets-manager-forbidden` で機械的に強制。

**ADR 参照**。

- `ADR-021` — 依存メジャーバンプ判断 (壊さずに更新する方針)
- `ADR-022` (tenant-isolation-audit) — テナント分離をどう検証するか

## 運用 (約 2 分)

**トークポイント**。

- **同じコードから 2 つの deploy mode**。 `make deploy` (Lite、 デフォルト) と `make deploy-saas` (マルチテナント)。 同じ Lambda と同じ採点 kind を再利用 — control plane stack 数と tenant pipeline だけが違う。
- **冪等な teardown**。 `scripts/cleanup.sh` はどんな partial-failure / partial-delete 状態からも安全に再実行できる。
- **polling UI は意図設計**。 SSE / WebSocket は `AGENTS.md` で禁止 — Lambda 運用モデルと衝突するから。 フロントエンドは polling、 EventBridge が polling を補強。
- **PR Discipline は機械強制**。 すべての PR で `make harness` が invariant を検査する —「PR body に `## Regression analysis` セクションがある」「PR body に `## Physical impact` セクションがある」など。 アーキテクチャ invariant と PR 衛生は同じチェック。

## マルチクラウドロードマップ (約 2 分)

**トークポイント**。

- 今日は **AWS のみ**。 production-grade マルチクラウドは名乗らない。 Cognito を Azure AD だと言い張ったりしない。
- 計画 : `ADR-023` (provider-specific 問題 runtime)。 問題はターゲットプロバイダ (`aws` / `azure` / `gcp`) を宣言できるようになり、 プラットフォームが deploy と採点を provider 別 worker に dispatch する。 プラットフォーム層 (events / 採点 kind / EventBridge) はクラウド非依存のまま。
- コミュニティ寄稿モデル : `ADR-024` (コミュニティ投票 + 問題レジストリ)。 投票 + キュレーション付きの問題レジストリで、 問題パックが fork にならずに伝播。

**ADR 参照**。

- `ADR-023` — Provider-specific 問題 runtime
- `ADR-024` — Community voting and problem registry

## Q&A の枠 (約 1 分)

質問を受けるときは、 回答を必ずファイルパスか ADR に紐付けます。 ファイルパスにも ADR にも紐付かない回答が出てきたら、 それは ADR を新規に書くべきサインです。 harness ルールの `adr-must-be-html` と `adr-self-contained` (`docs/architecture/harness.md`) が ADR を OSS readers 向け self-contained に保ちます。

## 次に読むもの

- [`docs/architecture/harness.md`](../architecture/harness.md) — invariant + PR Discipline (正本)
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](../architecture/adr-012-problem-plugin-architecture.html) — 中心となる設計決定
- [`infrastructure/templates/README.md`](../../infrastructure/templates/README.md) — 競技者側ブートストラップ
- [`problems/README.ja.md`](../../problems/README.ja.md) — 問題作成
- [`ROADMAP.md`](../../ROADMAP.md) — 出荷済み / 進行中の差分
