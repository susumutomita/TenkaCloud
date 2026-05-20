<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run AWS GameDay like GitHub Pages.**

Create cloud competitions in 5 minutes, deploy problems into each team's AWS
account, and watch scores update from a participant portal.

[30 sec demo](#30-second-demo) · [Try Lite](#try-lite-in-5-minutes) · [Create first problem](#create-your-first-problem)

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

</div>

---

## 30-Second Demo

TenkaCloud turns a problem directory into a playable cloud competition:

![TenkaCloud Lite demo flow](./docs/assets/tenkacloud-lite-demo.svg)

1. Author a problem with `metadata.json` and `template.yaml`.
2. Start Lite mode for a single event.
3. Deploy into each competitor's AWS account with AssumeRole + ExternalId.
4. Let participants recover, migrate, harden, or capture flags.
5. Score from health checks, flag submission, phased polling, or attack detection.

## Why TenkaCloud

Cloud competitions usually require a custom control plane, a deploy pipeline into
competitor accounts, a scoreboard, and per-team portals. TenkaCloud bundles those
pieces into one open-source platform.

| Need | TenkaCloud gives you |
| --- | --- |
| Run a one-off internal GameDay | Lite mode: Application Admin Console + Participant Portal + deploy backend |
| Deploy real infrastructure | CloudFormation lands in each competitor account via AssumeRole + ExternalId |
| Add new scenarios quickly | Problem plugin model: `metadata.json` + `template.yaml` + optional portal UI |
| Keep costs predictable | DynamoDB tables are forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect |
| Grow into SaaS mode | SBT control plane, pooled/silo tenants, Cognito, EventBridge, and tenant pipeline |

## Try Lite In 5 Minutes

Lite mode is the fastest path for one organizer running one competition. It skips
the SBT control plane and deploys the Application Admin Console, Participant
Portal, and deploy backend for a fixed local tenant.

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID and TENANT_ADMIN_EMAIL

make deploy
```

You get:

- **Application Admin Console**: choose problems, create deploys, watch progress.
- **Participant Portal**: team login, problem details, hints, submissions, scores.
- **Problem Deploy Backend**: DynamoDB + Lambda + Step Functions + CodeBuild.
- **Sample problems**: start with Hello World, then move to Battle scenarios.

Teardown:

```bash
make destroy
```

## Example Competitions

| Competition | Difficulty | What players practice |
| --- | --- | --- |
| [Hello World](./problems/challenges/hello-world/) | 1 | Read an SSM Parameter and submit a flag |
| [Hello World Battle](./problems/battles/hello-world-battle/) | 1 | Keep nginx + API endpoints alive under uptime scoring |
| [Security Battle Royale](./problems/battles/security-battle-royale/) | 3 | Patch a vulnerable web app while preserving availability |
| [Microservice Migration Battle](./problems/battles/microservice-migration-battle/) | 4 | Split a monolith into Lambda, ECS, and App Runner under time pressure |
| [StackStack](./problems/battles/stackstack/) | 4 | Ship AI-generated apps safely across auth, network, rate, audit, and UX controls |

Browse the curated catalog: [Competition Gallery](./docs/gallery.md).

## Create Your First Problem

A problem is a self-contained directory:

```text
problems/<category>/<id>/
├── metadata.json    # catalog display + scoring rule + portal slot wiring
├── template.yaml    # CloudFormation deployed to the competitor account
└── portal/          # optional React.lazy components for the Participant Portal
```

Create a scaffold:

```bash
bun run scripts/tenkacloud-problem.ts create my-first-challenge --kind flag
bun run scripts/tenkacloud-problem.ts validate my-first-challenge
```

Authoring references:

- [30-minute problem authoring guide](./docs/problems/AUTHORING.html)
- [Problem schema](./problems/SCHEMA.json)
- [Problem catalog README](./problems/README.md)

## Architecture

TenkaCloud has two operating modes:

| Mode | Use it when | Entry point |
| --- | --- | --- |
| **Lite** | You run one event and do not need tenant onboarding | `make deploy` |
| **SaaS** | You need a multi-tenant control plane and tenant provisioning pipeline | `make deploy-saas` |

Core planes:

- **Control Plane**: SBT tenant management, EventBridge bus, tenant pipeline.
- **Application Plane**: tenant admin console, participant portal, Cognito, APIs.
- **Problem Deploy Plane**: deploy worker that assumes the competitor role and
  creates CloudFormation stacks.
- **Trust Bridge**: `@TenkaCloud/trust-bridge` Cloud Action Intent protocol for
  cross-cloud authority transfer.

Start with these architecture docs:

- [ADR-012: Problem plugin architecture](./docs/architecture/adr-012-problem-plugin-architecture.html)
- [ADR-016: TenkaCloud Lite mode](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html)
- [ADR-017: Cloud Action Intent / Trust Bridge](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html)
- [Cloud Action Intent protocol spec](./docs/architecture/cloud-action-intent.html)

## Full Deployment

Use SaaS mode when you want tenant onboarding, pooled/silo tiers, and the full SBT
control plane:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit SYSTEM_ADMIN_EMAIL, AWS_ACCOUNT_ID, and AWS_REGION

make deploy-saas
```

The repository also includes targeted commands for local development:

```bash
make lite-status
make lite-console-url
make lite-portal-url
make before-commit
make harness
```

## Contributing

Contributor path:

- Read [CONTRIBUTING.md](./CONTRIBUTING.md).
- Pick a starter task from [ROADMAP.md](./ROADMAP.md#good-first-issue-candidates).
- Run `make before-commit` and `make harness` before opening a PR.

AI agent guidelines: [AGENTS.md](./AGENTS.md) · [CLAUDE.md](./CLAUDE.md)

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
