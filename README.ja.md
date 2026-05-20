<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**実 AWS アカウントで本格的なクラウドコンペティションを動かすための OSS プラットフォーム。**

Battle (リアルタイム対戦) と Challenge (個別演習) の問題を、 競技者ごとの AWS アカウントに直接 deploy する。 マルチテナント SaaS のインフラ込み。

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

🌐 [English](./README.md) · [日本語](./README.ja.md)

</div>

---

## なぜ TenkaCloud か

クラウドコンペティションには通常 3 つの要素が必要だが、 既存ツールはそのどれかが欠けている。 マルチテナント SaaS の Control Plane、 競技者の AWS アカウントに deploy する pipeline、 各チームが自分のスコアを見る portal。 TenkaCloud は 3 つすべてを 1 つの CDK app にまとめた。

- **実 AWS deploy** — 問題は CloudFormation template として、 AssumeRole + ExternalId 経由で競技者のアカウントに deploy される。 sandbox エミュレーションではない
- **マルチテナント設計** — SBT (Serverless SaaS Builder Toolkit) を Control Plane に採用。 per-tenant Cognito / DynamoDB / API Gateway を持つ Application Plane。 pooled と silo の tier を標準サポート
- **Free Tier 親和性** — 全 DynamoDB テーブルは CDK Aspect で PROVISIONED 1 RCU / 1 WCU に強制。 平常運用なら AWS Free Tier 内に収まる

## クイックスタート

### デフォルト: Lite mode — `make deploy`

ほとんどの運営者は 1 大会 1 主催で multi-tenant SaaS の抽象を必要としない。 `make deploy` のデフォルトは Lite mode で、 SBT Control Plane なしに Application Admin Console + Participant Portal が立ち上がる。

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# AWS_ACCOUNT_ID (ap-northeast-1 以外を使うなら AWS_REGION も) を編集

make deploy
```

得られるものは次の通り。

- **Application Admin Console** — Tenant Admin UI (CloudFront)
- **Participant Portal** — 競技者 UI (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- **`hello-world` 問題が同梱** — 自分の AWS account に deploy 可能

撤収は次のコマンドで実施する。

```bash
make destroy
```

### Opt-in: SaaS mode — `make deploy-saas`

複数 tenant / pooled tier (BASIC / STANDARD / PREMIUM) / silo tier (PLATINUM) / System Admin 招待を含む本格運用の起動コマンド。

```bash
make deploy-saas
make destroy-saas
```

SaaS mode は env file に `SYSTEM_ADMIN_EMAIL` が必須。 orchestration は [`scripts/install.sh`](./scripts/install.sh) を参照する。

## 機能

| | |
|---|---|
| **Battle 問題** | リアルタイム対戦型 |
| **Challenge 問題** | 個別演習・常設チャレンジ |
| **Plugin アーキテクチャ** | 1 問題 = `metadata.json` + `template.yaml` (+ 任意の `portal/*.tsx`)。 platform に手を入れずに問題を追加可能 |
| **5 種類の scoring kind** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` を 1 問題ごとに宣言 |
| **i18n** | 日本語 + 英語の 2 言語。 問題 metadata は locale 別に narrative を上書き可能 |
| **セキュリティ** | AssumeRole に必須 ExternalId、 secrets は SSM SecureString、 Cognito JWT + MFA、 per-team rate limiting |
<!-- textlint-disable spellcheck-tech-word -->
| **Trust Bridge** | `@TenkaCloud/trust-bridge` — Cloud Action Intent protocol でクラウド横断の権限委譲 (AWS + GCP + Azure adapter) |
<!-- textlint-enable spellcheck-tech-word -->
| **Observability** | CloudWatch Dashboard、 AWS Budgets、 CloudWatch Alarms (Lambda Errors / DDB throttling / API Gateway 5XX) を共有 SNS topic に集約。 admin console から AWS Console に直リンク |

## 問題の構成

1 問題 = 3 つの artifact を含むディレクトリで構成する。

```
problems/<category>/<id>/
├── metadata.json    # カタログ表示 + scoring rule + portal slot wiring
├── template.yaml    # 競技者 account に deploy される CloudFormation
└── portal/          # 任意の React.lazy components (Participant Portal 用)
```

新規問題の追加は次のコマンドで実施する。

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <flag|uptime-flat|...>
bun run scripts/tenkacloud-problem.ts validate <id>
```

Schema: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · onboarding guide: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | Vite、 React、 react-router、 [Cloudscape Design System](https://cloudscape.design/) |
| バックエンド | AWS Lambda (Node.js + Hono)、 API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws)、 cdk-nag |
| 認証 | AWS Cognito (Hosted UI + OAuth Code + PKCE)、 TOTP MFA |
| データ | DynamoDB (PROVISIONED 1/1、 Free Tier 親和) |
| イベント | EventBridge を cross-plane 通信に使用 |
| テスト | Vitest |
| Package 管理 | Bun (workspaces: `infrastructure` + `apps/*` + `packages/*`) |

## アーキテクチャ

アーキテクチャは [`docs/architecture/`](./docs/architecture/) 配下の HTML ADR にまとまっている。 ADR は表現力 (decision table / threat-model grid / 色分け badge) のため HTML で書いている。

主な入口は次の通り。

- [ADR-012 — Problem plugin architecture](./docs/architecture/adr-012-problem-plugin-architecture.html)
- [ADR-016 — TenkaCloud Lite mode](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html)
<!-- textlint-disable spellcheck-tech-word -->
- [ADR-017 — Cloud Action Intent / Trust Bridge](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html)
<!-- textlint-enable spellcheck-tech-word -->
- [Cloud Action Intent protocol spec](./docs/architecture/cloud-action-intent.html)

ADR 全索引は [`docs/architecture/`](./docs/architecture/) に置く。

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照。 概要は次の通り。

- [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue) ラベルの issue を選ぶ
- テストは必須 (Vitest)
- PR 前に `make before-commit` を必ず実行する
- Architecture invariant は `make harness` で機械強制する ([`docs/architecture/harness.md`](./docs/architecture/harness.md) 参照)

AI エージェント向けガイド: [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md)

## ライセンス

[Apache License 2.0](./LICENSE) — 商用利用 / 改変 / 配布すべて自由。 ライセンス表記のみ保持する。
