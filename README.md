# TenkaCloud

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

AWS 上で動くマルチテナント SaaS のクラウドコンペティション基盤。**Battle** (リアルタイム対戦) と **Challenge** (個別演習・常設チャレンジ) を 1 つの Control Plane / Application Plane / 競技者 AWS アカウントへの自動 deploy で配信する (旧称 GameDay / JAM)。

土台は AWS の Serverless SaaS Reference Architecture (`@cdklabs/sbt-aws` 0.3.9)。Control Plane / Application Plane / Tenant Pipeline / Problem Deploy backend を CDK で 1 つのレポに収めている。

## できること

- **System Admin** が tenant を発行 → 招待メール → tenant 作成 (BASIC / STANDARD / PREMIUM は pooled、PLATINUM は silo)。
- **Tenant Admin** が `application-admin-console` から competitor アカウントへ問題 (`problems/<id>/template.yaml`) を deploy。
- **競技者** は事前に `infrastructure/templates/competitor-bootstrap.yaml` を自分のアカウントで 1 回流すだけで、TenkaCloud から問題スタックが届く。問題エンドポイントとスコアは `participant-portal` で見る。
- 全データテーブルは DynamoDB の **PROVISIONED 1 RCU / 1 WCU** に強制 (Free Tier 25 RCU/WCU 内で運用可能)。

## アーキテクチャ

```
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│  admin-console     │   │ application-admin-console│   │  participant-portal    │
│  (System Admin)    │   │  (Tenant Admin)          │   │  (Competitor)          │
│  S3 + CloudFront   │   │  per-tenant CloudFront   │   │  S3 + CloudFront       │
└─────────┬──────────┘   └─────────────┬────────────┘   └────────────┬───────────┘
          │                            │                             │
          ▼                            ▼                             ▼
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│ ControlPlaneStack  │   │ TenantTemplateStack      │   │ ProblemDeployBackend   │
│  - Cognito         │   │  - per-tenant Cognito    │   │  - Deployments DDB     │
│  - Tenant CRUD API │──▶│  - Apps DDB / API GW     │   │  - HTTP API + Cognito  │
│  - EventBridge bus │   │  - silo or pooled        │   │  - Worker Lambda       │
└─────────┬──────────┘   └──────────────────────────┘   └────────────┬───────────┘
          │                                                          │
          │  onboardingRequest             DeployRequested            │
          ▼                                                          ▼
┌────────────────────┐                                  ┌────────────────────────┐
│ ServerlessSaaS     │                                  │ Competitor AWS account │
│   Pipeline         │                                  │  (AssumeRole +         │
│  (CodePipeline)    │                                  │   ExternalId)          │
└────────────────────┘                                  └────────────────────────┘
```

詳細は [`CLAUDE.md`](./CLAUDE.md) のアーキテクチャ節を参照。

## ディレクトリ

```
apps/
├── admin-console/                   # System Admin SPA (Vite + React 19 + Cloudscape)
├── application-admin-console/       # Tenant Admin SPA
└── participant-portal/              # Competitor SPA
infrastructure/                      # CDK (SBT 0.3.9) — backend は全部 Lambda
├── bin/infrastructure.ts            # 全 stack の配線エントリ
├── lib/                             # 各 stack 実装
├── environments/<env>/              # 環境別設定 (config.json + .env)
└── templates/                       # 競技者アカウント用 CFn テンプレート
scripts/                             # install.sh / cleanup.sh / provision-tenant.sh
problems/<category>/<id>/            # 1 ディレクトリ 1 問題 (metadata.json + template.yaml)
```

## 必要環境

- macOS / Linux
- [Bun](https://bun.sh/) 1.3.11 (`mise install` で `mise.toml` から取得可能)
- Node.js 24+ (CDK ts-node の実行用)
- Docker (CDK BucketDeployment の bundling に必要)
- AWS CLI v2 (deploy 時)
- AWS account に sts:AssumeRole / cdk bootstrap 権限のあるクレデンシャル

## セットアップ

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
```

依存は `infrastructure/` と `apps/*` の workspace すべてが入る。

## ローカル開発

各 SPA は独立した Vite dev server で動く。

```bash
# それぞれ別ターミナルで
cd apps/admin-console && make dev               # http://localhost:5173
cd apps/application-admin-console && make dev   # http://localhost:5174
cd apps/participant-portal && make dev          # http://localhost:5175
```

`apps/admin-console/` で実際のバックエンドに繋ぐ場合は `.env.local` を作って Cognito / API URL を設定する (`apps/admin-console/README.md` 参照)。

CDK スタックのユニットテスト・型チェックは workspace ルートから実行する。

```bash
make typecheck      # 全 workspace の tsc --noEmit
make test           # 全 workspace の vitest
make synth          # cdk synth (ENV=development)
```

## AWS にデプロイ

```bash
# 1. 環境設定ファイルを用意
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# → SYSTEM_ADMIN_EMAIL を編集

# 2. AWS CLI ログイン済みで
make deploy   # ENV=development が default
```

`scripts/install.sh` は次の 3 フェーズで動く。

1. backend stacks (ControlPlane / Bootstrap / pooled tenant / Pipeline) を deploy
2. `apps/admin-console` を build → `AdminConsoleHostingStack` (S3+CloudFront) を deploy
3. CloudFront URL を Control Plane の callback / CORS に追加して再 deploy

完了すると AdminConsole の URL と SystemAdmin 招待メールの送信先がコンソールに出る。

teardown は `make destroy` (`scripts/cleanup.sh`)。途中失敗状態からも冪等に動く。

## TenkaCloud Lite mode (試したい人向け)

ADR-016 で導入した **Lite mode** は SBT / Pipeline / 動的 tenant 作成のフル機能を持ち込まず、 `tenantId=local` 固定 + ApplicationAdminConsole + ProblemDeploy backend だけを 1 コマンドで AWS account に立てるための「触ってみる」向けエントリ。 OSS readers や Product Hunt 訪問者を迷わせない最小経路。

| 比較軸                   | Full mode (= `make deploy`)                                                            | Lite mode (= `make lite-up`)                                                |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tenant                   | SBT が動的に作成 (BASIC / STANDARD / PREMIUM = pooled、 PLATINUM = silo)                | `tenantId=local` 固定 (= 1 tenant)                                          |
| Stacks                   | ControlPlane + Bootstrap + Pipeline + pooled tenant + AdminConsole + ProblemDeploy 等 | TenkaCloudLiteStack (= AppPlaneCore) + ProblemDeployBackendStack の 2 つだけ |
| 招待メール               | SystemAdmin / TenantAdmin に Cognito 招待                                              | 自分で UserPool に user を追加 (= manual)                                    |
| EventBridge bus          | ControlPlane が払い出した shared bus                                                   | ProblemDeployBackendStack 内 local bus (= ADR-016 + #791 で optional 化)     |
| 3-phase deploy           | あり (= ControlPlane 再 deploy で CORS 更新)                                           | 単発 deploy のみ                                                            |
| 用途                     | 本格的な競技イベント、 multi-team                                                      | OSS 評価、 1 人ハンズオン、 動作確認                                         |

### `make lite-*` ターゲット

```bash
make lite-up            # Lite stack 2 個 (= AppPlane + ProblemDeploy) を deploy + URL を表示
make lite-down          # Lite stack 2 個を destroy
make lite-status        # 両 stack の StackStatus を 1 行で表示
make lite-portal-url    # Participant Portal の CloudFront URL を CFn output から取得
make lite-console-url   # Application Admin Console の CloudFront URL を取得
```

CLI 単体での起動は次の通り。

```bash
bun run scripts/tenkacloud-lite.ts <subcommand>
bun run scripts/tenkacloud-lite.ts help   # 5 subcommand の help を表示
```

> **Phase 4 scope の限界**: `tenkacloud-lite.ts` は CLI scaffold + Makefile target + unit test の最小単位で出荷している。 実 AWS deploy 経路に必要な `infrastructure/bin/tenkacloud-lite.ts` (= Lite 専用 bin entry) は Phase 5 で追加する。 現状の `make lite-up` は CDK の bin entry が無いと synth で失敗する。 Lite mode を本気で deploy したい場合は Phase 5 完了まで待つか、 Issue #778 に張られている Phase 5 PR を待ってほしい。

## 競技者側のセットアップ

競技者は自分の AWS アカウントで `infrastructure/templates/competitor-bootstrap.yaml` を 1 回 deploy する。これで TenkaCloud から AssumeRole + ExternalId で問題 CFn を deploy できる IAM Role が払い出される。詳細は [`infrastructure/templates/README.md`](./infrastructure/templates/README.md)。

## 問題を追加する

`problems/<category>/<id>/` を作って `metadata.json` (= [`problems/SCHEMA.json`](./problems/SCHEMA.json) に準拠) と `template.yaml` を置く。手順は [`problems/README.md`](./problems/README.md)。

検証は次のコマンドで実行する。

```bash
make validate-problems
```

## コマンド一覧

| コマンド                 | 用途                                                  |
| ------------------------ | ----------------------------------------------------- |
| `make install`           | 依存インストール (Bun)                                |
| `make build`             | 全 workspace を build                                 |
| `make typecheck`         | 全 workspace の tsc                                   |
| `make test`              | 全 workspace の vitest                                |
| `make lint` / `fix`      | markdownlint + textlint + biome (`fix` は自動修正)    |
| `make validate-problems` | 問題メタデータの schema 検証                          |
| `make before-commit`     | PR 前に必須のゲート (lint + test + validate-problems) |
| `make synth` / `diff`    | `cdk synth` / `cdk diff --all`                        |
| `make deploy`            | `scripts/install.sh` で 3-phase deploy                |
| `make destroy`           | `scripts/cleanup.sh` で全 stack + S3 を冪等に破棄     |
| `make harness`           | architecture invariant チェック                       |
| `make tech-debt`         | 技術的負債スキャン                                    |
| `make lite-up` / `down`  | Lite mode (= 1 tenant 固定) の deploy / destroy       |
| `make help`              | 全ターゲット一覧                                      |

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照。AI エージェント向けのルールは [AGENTS.md](./AGENTS.md) と [CLAUDE.md](./CLAUDE.md) に集約している。

## ライセンス

[Apache License 2.0](./LICENSE)
