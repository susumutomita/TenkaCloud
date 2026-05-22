<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Self-host AWS GameDay competitions as easily as a GitHub Pages site.**

Stand up a cloud competition in 5 minutes, deploy each problem straight into the
team's own AWS account, and watch the scoreboard update live in a participant
portal.

[30 sec demo](#30-second-demo) · [Try Lite](#try-lite-mode-in-5-minutes) · [Create first problem](#create-your-first-problem)

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

1. Author a problem as a `metadata.json` + `template.yaml` pair.
2. Start Lite mode for a single event.
3. Deploy the problem into each competitor's AWS account via AssumeRole + ExternalId.
4. Participants work through the scenario — restoring a broken service, migrating
   workloads, hardening a config, or capturing a flag.
5. The platform scores them automatically — by health check, flag submission,
   phased polling, or attack detection, depending on the problem.

## Why TenkaCloud

Running a cloud competition normally means building four things from scratch: a
control plane, a pipeline that deploys problem infrastructure into each
competitor's account, a scoreboard, and per-team portals. TenkaCloud ships all
four as one open-source platform.

| If you need to… | …TenkaCloud gives you |
| --- | --- |
| Run a one-off internal GameDay | **Lite mode** — Application Admin Console + Participant Portal + deploy backend, no multi-tenant setup |
| Deploy real AWS infrastructure | CloudFormation is created directly inside each competitor's AWS account using AssumeRole + a per-tenant ExternalId |
| Add new scenarios quickly | A **problem plugin model**: drop in `metadata.json` + `template.yaml` (and optional portal UI) and the platform picks it up |
| Keep costs predictable | A CDK Aspect pins every DynamoDB table to 1 RCU / 1 WCU PROVISIONED so the platform fits inside the AWS Free Tier |
| Grow into a SaaS product | **SaaS mode** — SBT-based control plane, pooled and silo tenant tiers, Cognito, EventBridge, and a per-tenant provisioning pipeline |

## Try Lite Mode in 5 Minutes

Lite mode is the fastest path when one organizer is running one event. It skips
the SBT control plane entirely and stands up just three things — the Application
Admin Console, the Participant Portal, and the deploy backend — under a single
hard-coded tenant ID.

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

- **Application Admin Console** — pick problems, kick off deploys, watch progress.
- **Participant Portal** — team login, problem details, hints, submissions, scores.
- **Problem deploy backend** — DynamoDB + Lambda + Step Functions + CodeBuild.
- **Sample problems** — start with Hello World, then move on to Battle scenarios.

Teardown:

```bash
make destroy
```

## Problem catalog

Problems live in a **separate repo**: [susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge). It is mounted here as a git submodule under `problems/`, so `make deploy` ships whatever catalog version the submodule currently points at.

For the current list of shipped problems, see the catalog repo's README. We do not mirror that list here so it cannot fall out of sync whenever a problem is added or removed.

For a visual tour of the bundled example competitions, see the [Competition Gallery](./docs/gallery.md).

## Create Your First Problem

Problem authoring happens in the catalog repo, not in this one. A problem is a self-contained directory under `battles/<id>/` or `challenges/<id>/`:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed into the competitor's account
portal/          # optional React components for the Participant Portal
services/        # optional in-stack code (docker-compose / Lambda payload / etc.)
```

The scaffolding CLI itself lives in this platform repo (it depends on shared TypeScript packages):

```bash
bun run scripts/tenkacloud-problem.ts create my-first-challenge --kind flag
bun run scripts/tenkacloud-problem.ts validate my-first-challenge
```

Move the generated directory into your local clone of the catalog repo and open a PR there. Once that PR merges, a platform-side maintainer bumps the submodule pointer in this repo to pull it in.

Authoring references:

- [30-minute problem authoring guide](./docs/problems/AUTHORING.html) — platform-side authoring narrative
- [Problem schema (`SCHEMA.json`)](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/SCHEMA.json) — catalog repo, source of truth
- [Catalog repo README](https://github.com/susumutomita/TenkaCloudChallenge#readme) — contributor flow on the catalog side

## Architecture

TenkaCloud has two operating modes:

| Mode | Use it when | Entry point |
| --- | --- | --- |
| **Lite** | You are running a single event and do not need tenant onboarding | `make deploy` |
| **SaaS** | You need a multi-tenant control plane and a per-tenant provisioning pipeline | `make deploy-saas` |

Core planes:

- **Control Plane** — SBT-based tenant management, EventBridge bus, tenant pipeline.
- **Application Plane** — tenant admin console, participant portal, Cognito, APIs.
- **Problem Deploy Plane** — worker Lambda that assumes the role in the
  competitor's account and creates the problem's CloudFormation stack there.
- **Trust Bridge** — the `@TenkaCloud/trust-bridge` package, which implements
  the Cloud Action Intent protocol: a signed intent gets exchanged for
  short-lived AWS credentials so the platform can act inside a competitor's
  account without ever holding long-lived keys.

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

Use SaaS mode when you need tenant onboarding, pooled / silo tenant tiers, and
the full SBT-based control plane:

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
