<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**The open-source platform for running real cloud competitions on real AWS accounts.**

Battle (real-time) and Challenge (self-paced) problems deployed straight to each competitor's own AWS account — multi-tenant SaaS infrastructure included.

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

🌐 [English](./README.md) · [日本語](./README.ja.md)

</div>

---

## Why TenkaCloud

Cloud competitions usually need three things that don't ship together: a multi-tenant SaaS control plane, a deploy pipeline into the *competitor's* AWS account, and a portal where each team sees their own scoreboard. TenkaCloud bundles all three into a single CDK app.

- **Real AWS deploys** — Problems are CloudFormation templates that land in the competitor's account via AssumeRole + ExternalId. No simulated sandbox.
- **Multi-tenant by design** — SBT (Serverless SaaS Builder Toolkit) for the control plane; per-tenant Cognito, DynamoDB, and API Gateway for the application plane. Pooled and silo tiers are supported out of the box.
- **Free Tier friendly** — Every DynamoDB table is forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect, so the whole platform fits under the AWS Free Tier when not under load.

## Quick start

### Default: Lite mode — `make deploy`

Most operators run one competition at a time, not a multi-tenant SaaS. `make deploy` defaults to Lite mode, deploying the Application Admin Console and Participant Portal without the SBT control plane:

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID (+ AWS_REGION if not ap-northeast-1)

make deploy
```

You get:

- **Application Admin Console** — Tenant Admin UI (CloudFront)
- **Participant Portal** — Competitor UI (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- A pre-seeded `hello-world` problem you can deploy to your own AWS account

Teardown:

```bash
make destroy
```

### Opt-in: SaaS mode — `make deploy-saas`

For multiple tenants, pooled tiers (BASIC / STANDARD / PREMIUM) and silo tier (PLATINUM), and System Admin onboarding:

```bash
make deploy-saas
make destroy-saas
```

SaaS mode requires `SYSTEM_ADMIN_EMAIL` in the env file. See [`scripts/install.sh`](./scripts/install.sh) for the orchestration.

## Features

| | |
|---|---|
| **Battle problems** | Real-time PvP-style competitions |
| **Challenge problems** | Self-paced, always-on training |
| **Plugin architecture** | Each problem ships its own `metadata.json` + `template.yaml` (+ optional `portal/*.tsx`) — no platform changes needed to add problems |
| **5 scoring kinds** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` — declared per problem |
| **i18n** | Japanese and English. Problem metadata supports per-locale narrative overrides |
| **Security** | Required ExternalId on AssumeRole; SSM SecureString for secrets; Cognito JWT + MFA; per-team rate limiting |
| **Trust Bridge** | `@TenkaCloud/trust-bridge` — Cloud Action Intent protocol for cross-cloud authority transfer (AWS + GCP + Azure adapters) |
| **Observability** | CloudWatch Dashboard, AWS Budgets, and CloudWatch Alarms (Lambda Errors / DDB throttling / API Gateway 5XX) wired to a shared SNS topic. Admin console links straight to AWS Console |

## How problems work

A problem is a self-contained directory of three artifacts:

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

Schema: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · Authoring guide: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vite, React, react-router, [Cloudscape Design System](https://cloudscape.design/) |
| Backend | AWS Lambda (Node.js + Hono), API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws), cdk-nag |
| Auth | AWS Cognito (Hosted UI + OAuth Code + PKCE), TOTP MFA |
| Data | DynamoDB (PROVISIONED 1/1, Free Tier friendly) |
| Events | EventBridge for cross-plane signalling |
| Tests | Vitest |
| Package | Bun (workspaces: `infrastructure` + `apps/*` + `packages/*`) |

## Architecture

Architecture is documented as a set of HTML ADRs in [`docs/architecture/`](./docs/architecture/). They use HTML for layout expressiveness (decision tables, threat-model grids, color-coded badges).

Start here:

- [ADR-012 — Problem plugin architecture](./docs/architecture/adr-012-problem-plugin-architecture.html)
- [ADR-016 — TenkaCloud Lite mode](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html)
- [ADR-017 — Cloud Action Intent / Trust Bridge](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html)
- [Cloud Action Intent protocol spec](./docs/architecture/cloud-action-intent.html)

Full ADR index lives under [`docs/architecture/`](./docs/architecture/).

## Comparison

| | TenkaCloud | AWS GameDay | CTFd | Hack The Box |
|---|---|---|---|---|
| Deploys to participant's own AWS | ✅ | ✅ | ❌ | ❌ |
| OSS / self-hostable | ✅ | ❌ | ✅ | ❌ |
| Multi-tenant SaaS layer | ✅ | N/A | ❌ | ❌ |
| Real-time PvP (Battle) | ✅ | ✅ | ❌ | Partial |
| Free Tier compatible | ✅ | ❌ | ✅ | N/A |
| Plugin-style problems | ✅ | ❌ | ✅ | ❌ |
| Trust Bridge (cross-cloud authority) | ✅ | ❌ | ❌ | ❌ |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). In short:

- Pick an issue labeled [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue)
- Tests are required (Vitest)
- Run `make before-commit` before opening a PR
- Architecture invariants are enforced by `make harness` (see [`docs/architecture/harness.md`](./docs/architecture/harness.md))

AI agent guidelines: [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md)

## License

[Apache License 2.0](./LICENSE) — Use commercially, modify, distribute. Just keep the notice.
