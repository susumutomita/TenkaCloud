<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**The open-source platform for running real cloud competitions on real AWS accounts.**

Battle (real-time) and Challenge (self-paced) problems deployed straight to each competitor's own AWS account — multi-tenant SaaS infrastructure included.

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
![GitHub last commit (by committer)](https://img.shields.io/github/last-commit/susumutomita/TenkaCloud)
![GitHub top language](https://img.shields.io/github/languages/top/susumutomita/TenkaCloud)
![GitHub pull requests](https://img.shields.io/github/issues-pr/susumutomita/TenkaCloud)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/susumutomita/TenkaCloud)
![GitHub repo size](https://img.shields.io/github/repo-size/susumutomita/TenkaCloud)

🌐 [English](./README.md) · [日本語](./README.ja.md)

</div>

---

## Why TenkaCloud

Cloud competitions usually need three things that don't ship together: a multi-tenant SaaS control plane, a deploy pipeline into the *competitor's* AWS account, and a portal where each team sees their own scoreboard. TenkaCloud bundles all three into a single CDK app.

- **🏗 Real AWS deploys** — Problems are CloudFormation templates that land in the competitor's account via AssumeRole + ExternalId. No simulated sandbox.
- **🔐 Multi-tenant by design** — SBT (Serverless SaaS Builder Toolkit) for the control plane; per-tenant Cognito, DynamoDB, and API Gateway for the application plane. Pooled tiers (BASIC/STANDARD/PREMIUM) and silo tier (PLATINUM) supported out of the box.
- **💸 Free Tier friendly** — Every DynamoDB table is forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect, so the whole platform fits under the AWS Free Tier when not under load.

## Quick start

### Lite mode (5 minutes, single tenant)

For evaluators and OSS contributors who want to see TenkaCloud running without setting up the full SBT control plane:

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit SYSTEM_ADMIN_EMAIL + AWS_ACCOUNT_ID

make lite-up    # cdk deploy 2 stacks (~10 min on first run)
```

What you get with `make lite-up`:

- **Application Admin Console** — Tenant Admin UI (CloudFront)
- **Participant Portal** — Competitor UI (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- **Local EventBridge** — no shared bus, no control plane required
- A pre-seeded `hello-world` problem you can deploy to your *own* AWS account

Teardown:

```bash
make lite-down
```

### Full mode (multi-tenant SaaS)

For running real competitions with multiple tenants, pooled tiers, and System Admin onboarding:

```bash
make deploy   # 3-phase install.sh: backend → admin console → callback CORS
```

`scripts/install.sh` handles the SBT 3-phase deploy (control plane → admin console hosting → callback CORS update).

## Architecture at a glance

```
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│  Admin Console     │   │ Application Admin Console│   │  Participant Portal    │
│  (System Admin)    │   │  (Tenant Admin)          │   │  (Competitors)         │
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
│ ServerlessSaaS     │                                  │ Competitor AWS Account │
│   Pipeline         │                                  │  (AssumeRole + ExtId)  │
│  (CodePipeline)    │                                  └────────────────────────┘
└────────────────────┘
```

## Features

| | |
|---|---|
| 🎮 **Battle problems** | Real-time PvP-style competitions (security battle royale, microservice migration battle, etc.) |
| 🧩 **Challenge problems** | Self-paced, always-on training (hello-world, AWS service deep-dives) |
| 🔌 **Plugin architecture** | Each problem ships its own `metadata.json` + `template.yaml` (+ optional `portal/*.tsx`) — no platform changes needed to add problems |
| 📊 **5 scoring kinds** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` — declared per problem |
| 🌐 **i18n** | Default JA, with EN / ES / ZH locale overrides on each problem's metadata |
| 🛡 **Security** | Required ExternalId on AssumeRole; SSM SecureString for secrets; Cognito JWT auth everywhere; per-team rate limiting |
| 📡 **Trust Bridge** | `@TenkaCloud/trust-bridge` — Cloud Action Intent protocol for cross-cloud authority transfer (AWS + GCP + Azure adapters, see [ADR-017](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html)) |
| 🔭 **Observability** | CloudWatch Dashboard with deploy chain / DDB / Lambda / API GW in one screen; structured trace logs with `correlationId` |

## How problems work

A problem is a self-contained directory of three artifacts (see [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html)):

```
problems/<category>/<id>/
├── metadata.json    # catalog display + scoring rule + portal slot wiring
├── template.yaml    # CloudFormation deployed to competitor's account
└── portal/          # optional React.lazy components for the Participant Portal
```

To add a new problem:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <flag|uptime-flat|...>
bun run scripts/tenkacloud-problem.ts validate <id>
```

Schema reference: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · Authoring guide: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vite 7, React 19, react-router 7, [Cloudscape Design System](https://cloudscape.design/) |
| Backend | AWS Lambda (Node.js 22 + Hono), API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws) 0.3.9, cdk-nag |
| Auth | AWS Cognito (Hosted UI + OAuth Code + PKCE) |
| Data | DynamoDB (PROVISIONED 1/1, Free Tier friendly) |
| Events | EventBridge (cross-plane: tenant creation / DeployRequested / DeployCompleted) |
| Tests | Vitest (1000+ tests, Japanese `〜すべき` test titles) |
| Package | Bun 1.3.11 (workspaces: `infrastructure` + `apps/*` + `packages/*`) |

## Architecture Decision Records (ADRs)

ADRs are written in HTML for layout expressiveness (decision tables, threat-model grids, color-coded badges). Browse at [`docs/architecture/`](./docs/architecture/):

- [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html) — Problem plugin architecture (5 scoring kinds, thick metadata DSL)
- [ADR-013](./docs/architecture/adr-013-disruption-phase2-condition-triggered.html) — Condition-triggered disruptions
- [ADR-014](./docs/architecture/adr-014-eventbridge-driven-state-reconciliation.html) — EventBridge-driven state reconciliation
- [ADR-015](./docs/architecture/adr-015-adr-convention-as-harness.html) — ADR convention enforced as harness
- [ADR-016](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html) — TenkaCloud Lite mode + AppPlaneCore extraction
- [ADR-017](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html) — Cloud Action Intent / Trust Bridge for cross-cloud authority transfer
- [Cloud Action Intent protocol spec](./docs/architecture/cloud-action-intent.html) — Wire format reference (RFC 7515 JWS compact serialization, 13-section threat model)

## Roadmap

- ✅ Lite mode (single-tenant, OSS-friendly) — Issue [#778](https://github.com/susumutomita/TenkaCloud/issues/778)
- ✅ Trust Bridge library (AWS adapter + GCP / Azure prototypes) — Issue [#795](https://github.com/susumutomita/TenkaCloud/issues/795)
- 🔄 Cross-cloud problem support (GCP / Azure / Cloudflare targets)
- 🔄 Problem marketplace (`TenkaCloudChallenges` private repo for paid / private problems)
- 📋 Tournament mode (multi-event scheduling, leaderboard aggregation)

## Comparison

| | TenkaCloud | AWS GameDay | CTFd | Hack The Box |
|---|---|---|---|---|
| Deploys to participant's own AWS | ✅ | ✅ | ❌ | ❌ |
| OSS / self-hostable | ✅ | ❌ | ✅ | ❌ |
| Multi-tenant SaaS layer | ✅ | N/A | ❌ | ❌ |
| Real-time PvP (Battle) | ✅ | ✅ | ❌ (CTF only) | Partial |
| Free Tier compatible | ✅ | ❌ | ✅ | N/A |
| Plugin-style problems | ✅ | ❌ | ✅ | ❌ |
| Trust Bridge (cross-cloud authority) | ✅ | ❌ | ❌ | ❌ |

## Contributing

We welcome contributions. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then:

- Pick an issue labeled [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue)
- Tests are required (Vitest, `〜すべき` style for Japanese / `should` for English)
- Run `make before-commit` before opening a PR
- Architecture invariants are enforced by `make harness` (see [`docs/architecture/harness.md`](./docs/architecture/harness.md))

AI agent guidelines: [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md)

## Star history

If TenkaCloud helps you run a cloud competition, please consider starring the repo — it helps us understand the OSS community's appetite for this kind of platform.

[![Star History Chart](https://api.star-history.com/svg?repos=susumutomita/TenkaCloud&type=Date)](https://star-history.com/#susumutomita/TenkaCloud&Date)

## License

[Apache License 2.0](./LICENSE) — Use commercially, modify, distribute. Just keep the notice.

---

<div align="center">

Built with care by [Susumu Tomita](https://susumutomita.netlify.app/) and contributors.

</div>
