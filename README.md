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

## Problem catalog

Problems live in a **separate repo**: [susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge). It is mounted here as a git submodule at `problems/`, so `make deploy` bundles whichever catalog snapshot the submodule pointer references.

See the catalog repo's README for the current list of shipped problems. We deliberately do not duplicate that list here to avoid drift whenever a problem is added.

A high-level pictorial view of the platform's example competitions also lives in the [Competition Gallery](./docs/gallery.md), curated for visitors.

## Create Your First Problem

Problem authoring happens in the catalog repo, not here. A problem is a self-contained directory under `battles/<id>/` or `challenges/<id>/` in that repo:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed to the competitor account
portal/          # optional React components for the Participant Portal
services/        # optional in-stack code (docker-compose / Lambda payload / etc)
```

The scaffolding CLI is still hosted in this platform repo because it depends on shared TypeScript packages:

```bash
bun run scripts/tenkacloud-problem.ts create my-first-challenge --kind flag
bun run scripts/tenkacloud-problem.ts validate my-first-challenge
```

Move the generated directory into your local clone of the catalog repo, open a PR there, and a platform-side maintainer bumps the submodule pointer once it merges.

Authoring references:

- [30-minute problem authoring guide](./docs/problems/AUTHORING.html) — platform-side authoring narrative
- [Problem schema (`SCHEMA.json`)](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/SCHEMA.json) — catalog repo, source of truth
- [Catalog repo README](https://github.com/susumutomita/TenkaCloudChallenge#readme) — contributor flow on the catalog side

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

- **For first-time contributors** (10-min reads):
  - [`docs/architecture/OVERVIEW.md`](./docs/architecture/OVERVIEW.md) — full architectural narrative
  - [`CONTRIBUTOR_MAP.md`](./CONTRIBUTOR_MAP.md) — "I want to do X" navigation
  - [`docs/architecture/MODULE_MAP.md`](./docs/architecture/MODULE_MAP.md) — "where is X" directory map
  - [`docs/architecture/GLOSSARY.md`](./docs/architecture/GLOSSARY.md) — term definitions with ADR back-links
- **Decision rationales (ADRs)**:
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
