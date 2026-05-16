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
![GitHub last commit (by committer)](https://img.shields.io/github/last-commit/susumutomita/TenkaCloud)
![GitHub top language](https://img.shields.io/github/languages/top/susumutomita/TenkaCloud)
![GitHub pull requests](https://img.shields.io/github/issues-pr/susumutomita/TenkaCloud)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/susumutomita/TenkaCloud)
![GitHub repo size](https://img.shields.io/github/repo-size/susumutomita/TenkaCloud)

🌐 [English](./README.md) · [日本語](./README.ja.md)

</div>

---

## なぜ TenkaCloud か

クラウドコンペティションには通常 3 つの要素が必要だが、 既存ツールはそのどれかが欠けている: マルチテナント SaaS の Control Plane、 競技者の AWS アカウントに deploy する pipeline、 各チームが自分のスコアを見る portal。 TenkaCloud は 3 つすべてを 1 つの CDK app にまとめた。

- **🏗 実 AWS deploy** — 問題は CloudFormation template で、 AssumeRole + ExternalId 経由で競技者のアカウントに deploy される。 sandbox エミュレーションではない
- **🔐 マルチテナント設計** — SBT (Serverless SaaS Builder Toolkit) を Control Plane に採用。 per-tenant Cognito / DynamoDB / API Gateway を持つ Application Plane。 pooled (BASIC / STANDARD / PREMIUM) と silo (PLATINUM) tier を標準サポート
- **💸 Free Tier 親和性** — 全 DynamoDB テーブルは CDK Aspect で PROVISIONED 1 RCU / 1 WCU に強制。 平常運用なら AWS Free Tier 内に収まる

## クイックスタート

### Lite mode (5 分、 1 tenant)

OSS contributor が SBT の Control Plane なしで TenkaCloud を試したい場合の手順は次の通り。

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# SYSTEM_ADMIN_EMAIL + AWS_ACCOUNT_ID を編集

make lite-up    # cdk deploy 2 stack (初回 ~10 分)
```

`make lite-up` で得られるものは次の通り。

- **Application Admin Console** — Tenant Admin UI (CloudFront)
- **Participant Portal** — 競技者 UI (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- **Local EventBridge** — Control Plane 不要、 stack 内自己完結
- **`hello-world` 問題が同梱** — 自分の AWS account に deploy 可能

撤収は次のコマンドで実施する。

```bash
make lite-down
```

### Full mode (マルチテナント SaaS)

複数 tenant / pooled tier / System Admin 招待を含む本格運用の起動コマンド。

```bash
make deploy   # 3-phase install.sh: backend → admin console → callback CORS
```

`scripts/install.sh` が SBT の 3-phase deploy を担当 (Control Plane → admin console hosting → callback CORS 更新)。

## アーキテクチャ

```
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│  Admin Console     │   │ Application Admin Console│   │  Participant Portal    │
│  (System Admin)    │   │  (Tenant Admin)          │   │  (競技者)              │
│  S3 + CloudFront   │   │  per-tenant CloudFront   │   │  S3 + CloudFront       │
└─────────┬──────────┘   └─────────────┬────────────┘   └────────────┬───────────┘
          │                            │                             │
          ▼                            ▼                             ▼
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│ ControlPlaneStack  │   │ TenantTemplateStack      │   │ ProblemDeployBackend   │
│  (SBT)             │   │  per-tenant runtime      │   │  Step Functions +      │
│  Cognito + EvBridge│──▶│  Cognito + DDB + API GW  │   │  CodeBuild + Lambda    │
└─────────┬──────────┘   └──────────────────────────┘   └────────────┬───────────┘
          │                                                          │
          │  onboardingRequest             DeployRequested            │
          ▼                                                          ▼
┌────────────────────┐                                  ┌────────────────────────┐
│ ServerlessSaaS     │                                  │ 競技者 AWS Account     │
│   Pipeline         │                                  │  (AssumeRole + ExtId)  │
│  (CodePipeline)    │                                  └────────────────────────┘
└────────────────────┘
```

## 機能

| | |
|---|---|
| 🎮 **Battle 問題** | リアルタイム対戦型 (security battle royale、 microservice migration battle 等) |
| 🧩 **Challenge 問題** | 個別演習・常設チャレンジ (hello-world、 AWS サービス深堀り) |
| 🔌 **Plugin アーキテクチャ** | 1 問題 = `metadata.json` + `template.yaml` (+ 任意の `portal/*.tsx`)。 platform に手を入れずに問題を追加可能 |
| 📊 **5 種類の scoring kind** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` を 1 問題ごとに宣言 |
| 🌐 **i18n** | 日本語をデフォルト、 EN / ES / ZH の locale override を問題 metadata に書ける |
| 🛡 **セキュリティ** | AssumeRole に必須 ExternalId、 secrets は SSM SecureString、 全 API に Cognito JWT、 per-team rate limiting |
<!-- textlint-disable spellcheck-tech-word -->
| 📡 **Trust Bridge** | `@TenkaCloud/trust-bridge` — Cloud Action Intent protocol でクラウド横断の権限委譲 (AWS + GCP + Azure adapter、 [ADR-017](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html) を参照) |
<!-- textlint-enable spellcheck-tech-word -->
| 🔭 **Observability** | CloudWatch Dashboard で deploy chain / DDB / Lambda / API GW を 1 画面、 `correlationId` 入り structured trace log |

## 問題の構成

1 問題 = 3 つの artifact を含むディレクトリ ([ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html) 参照) で構成する。

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

Schema reference: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · 30 分 onboarding: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | Vite 7、 React 19、 react-router 7、 [Cloudscape Design System](https://cloudscape.design/) |
| バックエンド | AWS Lambda (Node.js 22 + Hono)、 API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws) 0.3.9、 cdk-nag |
| 認証 | AWS Cognito (Hosted UI + OAuth Code + PKCE) |
| データ | DynamoDB (PROVISIONED 1/1、 Free Tier 親和) |
| イベント | EventBridge (cross-plane: tenant 作成 / DeployRequested / DeployCompleted) |
| テスト | Vitest (1000+ tests、 日本語「〜すべき」 形式) |
| Package 管理 | Bun 1.3.11 (workspaces: `infrastructure` + `apps/*` + `packages/*`) |

## アーキテクチャ決定記録 (ADR)

ADR は表現力 (decision table / threat-model grid / 色分け badge) のため HTML で書いている。 詳細は [`docs/architecture/`](./docs/architecture/) を参照する。

- [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html) — Problem plugin architecture
- [ADR-013](./docs/architecture/adr-013-disruption-phase2-condition-triggered.html) — Condition-triggered disruptions
- [ADR-014](./docs/architecture/adr-014-eventbridge-driven-state-reconciliation.html) — EventBridge-driven state reconciliation
- [ADR-015](./docs/architecture/adr-015-adr-convention-as-harness.html) — ADR convention を harness で機械強制
- [ADR-016](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html) — TenkaCloud Lite mode + AppPlaneCore 抽出
<!-- textlint-disable spellcheck-tech-word -->
- [ADR-017](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html) — Cloud Action Intent / Trust Bridge (クラウド横断権限委譲)
<!-- textlint-enable spellcheck-tech-word -->
- [Cloud Action Intent protocol spec](./docs/architecture/cloud-action-intent.html) — wire format reference (RFC 7515 JWS、 13 セクション)

## ロードマップ

- ✅ Lite mode (1 tenant、 OSS 親和) — Issue [#778](https://github.com/susumutomita/TenkaCloud/issues/778)
- ✅ Trust Bridge library (AWS adapter + GCP / Azure prototype) — Issue [#795](https://github.com/susumutomita/TenkaCloud/issues/795)
- 🔄 クロスクラウド問題対応 (GCP / Azure / Cloudflare ターゲット)
- 🔄 問題マーケットプレイス (`TenkaCloudChallenges` private repo で有償 / 非公開問題)
- 📋 トーナメントモード (multi-event スケジューリング、 リーダーボード集計)

## 他プラットフォームとの比較

| | TenkaCloud | AWS GameDay | CTFd | Hack The Box |
|---|---|---|---|---|
| 競技者の AWS account に deploy | ✅ | ✅ | ❌ | ❌ |
| OSS / セルフホスト可 | ✅ | ❌ | ✅ | ❌ |
| マルチテナント SaaS 層 | ✅ | N/A | ❌ | ❌ |
| リアルタイム PvP (Battle) | ✅ | ✅ | ❌ (CTF のみ) | 部分的 |
| Free Tier 親和 | ✅ | ❌ | ✅ | N/A |
| Plugin 型問題 | ✅ | ❌ | ✅ | ❌ |
| Trust Bridge (クラウド横断権限) | ✅ | ❌ | ❌ | ❌ |

## コントリビューション

歓迎します。 まず [CONTRIBUTING.md](./CONTRIBUTING.md) を確認したうえで次のいずれかから始めてください。

- [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue) ラベルの issue を選ぶ
- テストは必須 (Vitest、 日本語「〜すべき」形式 / English の場合 `should` 形式)
- PR 前に `make before-commit` を必ず実行する
- Architecture invariant は `make harness` で機械強制 ([`docs/architecture/harness.md`](./docs/architecture/harness.md) 参照)

AI エージェント向けガイド: [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md)

## Star History

TenkaCloud が役に立ったら star を付けてもらえると OSS コミュニティの関心を測る指標になり、 開発の優先度を判断するヒントになる。

[![Star History Chart](https://api.star-history.com/svg?repos=susumutomita/TenkaCloud&type=Date)](https://star-history.com/#susumutomita/TenkaCloud&Date)

## ライセンス

[Apache License 2.0](./LICENSE) — 商用利用 / 改変 / 配布すべて自由。 ライセンス表記のみ保持してほしい。

---

<div align="center">

Built with care by [Susumu Tomita](https://susumutomita.netlify.app/) and contributors.

</div>
