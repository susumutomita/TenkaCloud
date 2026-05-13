# AGENTS.md — TenkaCloud

AI エージェント (Claude Code, Codex CLI 等) 向けのガイド。プロダクト全体の正本は @CLAUDE.md。本ファイルは「エージェントとして動くときに守る運用ルール」だけに絞る。

## 役割分担

- **インフラ (CDK / SBT / IAM / `infrastructure/templates/`) はユーザーが書く**。CDK スタック、IAM ポリシー、CFn テンプレートはユーザー判断で進める。提案は OK だが勝手に編集しない。
- **アプリ (`apps/*`、`scripts/*` の orchestration、`problems/*`) はエージェントが進める**。テストを書き、`make before-commit` を通し、PR を出すところまで一気通貫で。
- 不明点はまず repo を読む (`git log`, `git diff main...HEAD`, 関連 stack の test)。それでも判断つかないときだけユーザーに問う。

## 一気通貫で動く

中間で「次に進めていいですか？」と止まらない。タスクが完了するまで連続で進めて、最後に結果だけ報告する。途中で軌道修正があれば次の発話で受け取る。

次の例外を除く。

- 破壊的操作 (`rm -rf`、`git reset --hard`、強制 push、`make destroy`、本番への deploy)
- 共有環境への push / PR 作成 / Slack 投稿等の外部副作用
- シークレット (.env, AWS credentials) を扱う操作

これらは確認を取る。

## 品質ゲート

PR 作成前に **この順序で** 通すこと。

```bash
make harness         # architecture invariant チェック (docs/architecture/harness.md)
make before-commit   # lint (markdownlint + textlint + biome) / typecheck / test / validate-problems
/review              # コードレビュー
/security-review     # セキュリティレビュー
/simplify            # 重複・複雑度・効率の最終チェック
```

何か落ちたらコードを直す。設定ファイル (`biome.json`, `vitest.config.ts`, `tsconfig.json`) を直接いじって誤魔化さない。

`make harness` が落ちる場合は `docs/architecture/harness.md` の invariant ID と照らし合わせる。harness 自体のテストは `make harness-test`、ハーネスのルールロジックは `.claude/harness/src/architecture.ts` と `tech-debt.ts`。

CI (`.github/workflows/ci.yml`) は `make install_ci` → textlint → format check → typecheck → test → build。ローカル `make before-commit` が通れば CI は通る前提。

## 利用可能な skills

`/<skill>` で起動する。実体は `.claude/skills/<skill>/SKILL.md`。

| skill              | 用途                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `/harness`         | `make harness` を走らせて invariant 違反を検出                       |
| `/tech-debt`       | `make tech-debt` で技術的負債バックログを生成                         |
| `/create-problem`  | `problems/<category>/<id>/` を `metadata.json` + `template.yaml` で雛形生成 |
| `/spec`            | Open Web Docs (MDN) スタイルの技術仕様書を書く                       |

加えて TenkaCloud 関係なく使える共通 skill (`/review`、`/security-review`、`/simplify`、`/init` 等) は Claude Code 本体側に同梱されている。

## ブランチと PR

- **マージ済みブランチに push しない**。PR を出す前に必ず `gh pr view --json state` で state を確認。`MERGED` / `CLOSED` なら新ブランチを切る。
- 小さな意味単位で PR を分ける。`feat(...)` `fix(...)` `refactor(...)` `docs(...)` `test(...)` `chore(...)` のいずれか (Conventional Commits)。
- PR タイトルは 70 文字以内。本文に Summary + Test plan を書く。
- Issue 引用は GitHub の auto-close keyword に揃える:
  - **解決して閉じる** = `Closes #553` / `Fixes #553` / `Resolves #553` (= merge 時に GitHub が auto-close)
  - **関連だが閉じない (= partial fix / backlink)** = `Relates #553` または非 keyword 位置で `#553` を書く
  - **PR 同士の参照** = `PR-565` のように番号 prefix
  - 旧ルール (= `(#N)` の括弧で auto-close 抑止) は誤解だった。`Closes` などの keyword が無ければ `#N` 単独で auto-close されない (= backlink のみ作る)。

## コーディング規約

- **HTTP status code は `StatusCodes.*` (`http-status-codes` library) を使う**。`c.json(body, 200)` / `res.status === 401` のような数値リテラル直書きは禁止。意図 (200 vs 202、400 vs 409 等) を name で明示し、grep / lint で意味検索を可能にする。
  - backend: `import { StatusCodes } from "http-status-codes"; return c.json(body, StatusCodes.OK);`
  - frontend: `if (res.status === StatusCodes.UNAUTHORIZED) ...`
  - legacy alias (`HTTP_OK` 等、`infrastructure/lib/problem-deploy/handlers/shared/http-status.ts`) は deprecated。新規コードでは使わない

## 禁止事項

- `npx` → `bunx` または `nlx`
- `rm` (環境破壊リスク) → `git rm`
- HTTP status code の数値リテラル直書き — `StatusCodes.*` を使う
- モック / スタブで握り潰す fallback / 空配列を返して見せかける処理
- 設定ファイル (`biome.json`, `vitest.config.*`, `tsconfig.json`) の直接編集
- DynamoDB の on-demand (`PAY_PER_REQUEST`) 化 — `DynamoDbLowCapacity` Aspect で 1/1 PROVISIONED 強制
- SSE / WebSocket の新規導入 — Lambda 運用と整合する **polling** で書く
- シークレットのコミット (`infrastructure/environments/<env>/.env`、AWS credentials)

## TDD

テストを先に書く。テストタイトルは日本語「〜すべき」形式。

```typescript
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { App, Stack } from "aws-cdk-lib";

describe("AdminConsoleHostingStack", () => {
  it("CloudFront distribution に runtime-config.json が配置されるべき", () => {
    const app = new App();
    const stack = new AdminConsoleHostingStack(app, "Test", { /* ... */ });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", { /* ... */ });
  });
});
```

CDK の test では `Template.fromStack(stack)` で生成 CFn を assertion する。Lambda handler のユニットテストは `vi.mock` で AWS SDK clients をモックする。

## ディレクトリ早見

```
apps/
  admin-console/                   # System Admin (Cognito Hosted UI / OAuth Code+PKCE)
  application-admin-console/       # Tenant Admin (per-tenant Application Plane)
  participant-portal/              # 競技者ポータル (per-team login key)
infrastructure/
  bin/infrastructure.ts            # 全 stack の配線
  lib/control-plane-stack.ts       # SBT ControlPlane
  lib/bootstrap-template/          # TenantMappingTable
  lib/tenant-template/             # 1 tenant の API + Cognito + ApplicationConsole
  lib/tenant-pipeline/             # CodePipeline 経由の per-tenant provisioning
  lib/problem-deploy/              # 競技者 AWS への問題 deploy backend
  lib/admin-console-hosting.ts     # admin-console S3+CloudFront 配信
  lib/cdk-aspect/                  # DynamoDbLowCapacity / DestroyPolicySetter
  environments/<env>/              # config.json + .env
  templates/competitor-bootstrap.yaml  # 競技者アカウントで流す IAM Role
scripts/
  install.sh                       # 3-phase deploy のオーケストレーション
  cleanup.sh                       # 冪等な teardown
  provision-tenant.sh              # CodeBuild から呼ばれる per-tenant deploy
  deprovision-tenant.sh            # tenant 削除
problems/<category>/<id>/          # metadata.json + template.yaml が正本
```

## クロスプレーン契約 (壊さない)

- **EventBridge bus** は `ControlPlaneStack` が払い出し、`bin/infrastructure.ts` が他 stack に ARN を渡す。新 stack を追加するときも同じ bus を使う。
- **Tenant 作成イベント** (`onboardingRequest`) は `ServerlessSaaSPipeline` が拾って per-tenant stack を deploy する。BASIC / STANDARD / PREMIUM は pooled stack を共有、PLATINUM のみ silo stack を立てる。
- **DeployRequested イベント** は `ProblemDeployBackendStack` の Worker Lambda が拾い、tenant の ExternalId で競技者アカウントに AssumeRole → CFn CreateStack する。**ExternalId は必ず要求** (省略不可)。
- **Frontend の URL** は `runtime-config.json` (CloudFront 配下) 経由で注入される。`apps/*/src/config.ts` に `loadConfig()` がある。新しい URL を追加するときは hosting stack の env と config.ts の interface を両方更新する。

## Problem Authoring (ADR-012)

新しい問題を追加するときの正本は次の 3 点です。

- **正本 schema**: [`problems/SCHEMA.json`](./problems/SCHEMA.json) — `metadata.json` の JSON Schema
- **30 分 onboarding guide**: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — step-by-step + 5 kind の決定木 + 実例 4 問
- **Claude Code skill**: `.claude/skills/create-problem/SKILL.md` — `/create-problem` で起動、要件ヒアリング → 雛形生成 → metadata 編集まで誘導

問題は **3-asset model** (ADR-012):

```
problems/<category>/<id>/
├── metadata.json    # catalog 表示 + scoring engine + portal plugin 配線の正本
├── template.yaml    # CFn ペライチ (deploy 本体、 競技者 account に直接 deploy)
└── portal/          # 任意 (= dashboard.slots で宣言した tsx)
```

採点は 5 種の builtin kind (`flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`) を 1 問題 1 つ宣言する。 platform 側 generic scoring Lambda (= ADR-012 Phase 3) が dispatch する。 問題固有の scoring code を platform に書かない。

雛形生成 CLI を備えています。

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>
bun run scripts/tenkacloud-problem.ts validate <id>
bun run scripts/tenkacloud-problem.ts list-kinds
```

雛形 templates: `.claude/templates/problems/<kind>/` に 5 kind 分 (`flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`)。

## 参照

- @CLAUDE.md — プロダクト全体・アーキテクチャ・コマンド一覧
- [`docs/architecture/harness.md`](./docs/architecture/harness.md) — invariant + PR Discipline の正本
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](./docs/architecture/adr-012-problem-plugin-architecture.html) — 問題 = plugin、 platform = host の設計
- [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — 問題作成 30 分 onboarding
- [`infrastructure/templates/README.md`](./infrastructure/templates/README.md) — 競技者アカウント側のセットアップ
- [`problems/README.md`](./problems/README.md) — 問題追加の手順とスキーマ
- `apps/<app>/README.md` — 各 SPA のローカル開発手順
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — CI が走らせるコマンド
