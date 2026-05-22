<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run team-based cloud drills on real AWS, without building the event platform yourself.**

Open-source platform for hands-on AWS competitions. Battle (real-time) and Challenge
(self-paced) drills are auto-deployed into isolated AWS environments for each team,
with scoring, progress tracking, and AWS Console access built in.

[Landing page](https://susumutomita.github.io/TenkaCloud/) · [Play the mock](https://susumutomita.github.io/TenkaCloud/portal-demo/?demo=1) · [30 sec demo](#30-second-demo) · [Try Lite](#try-lite-mode-in-5-minutes) · [Create first problem](#create-your-first-problem)

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

</div>

> TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.

---

## Who it's for

Hands-on AWS training that you can run repeatedly inside your organization — without
building the event platform from scratch.

- **Cloud Enablement / CCoE teams** running new-grad onboarding, internalization
  programs, or recurring cross-team AWS drills.
- **Platform / SRE teams** that need to design and operate drills for their org
  (each team gets its own isolated AWS environment, scoring and Console access are
  aggregated, a week of setup collapses into an afternoon).
- **Engineers, meetups, and schools** that just want to self-host the OSS on their
  own AWS account and run something for free.

Two modes co-exist in a single event:

- **Battle** — real-time uptime drills where a health probe hits every team every
  minute. Last team standing wins.
- **Challenge** — self-paced problems where you solve and submit a flag. Learn one
  AWS service at a time, in depth.

## 30-Second Demo

TenkaCloud turns a problem directory into a playable cloud competition:

![TenkaCloud Lite demo flow](./docs/assets/tenkacloud-lite-demo.svg)

1. Author a problem as a `metadata.json` + `template.yaml` pair.
2. Start Lite mode for a single event.
3. Each team's stack is deployed into an isolated AWS environment via AssumeRole
   (with a per-tenant ExternalId).
4. Participants work through the scenario — restoring a broken service, migrating
   workloads, hardening a config, or capturing a flag.
5. The platform scores them automatically — by health check, flag submission,
   phased polling, or attack detection, depending on the problem.

Want to see the participant experience before deploying anything? **[Play the
mock](https://susumutomita.github.io/TenkaCloud/portal-demo/?demo=1)** — same
codebase, fixture data, no AWS account needed.

## Why TenkaCloud

Running a cloud competition normally means building four things from scratch: a
control plane, a pipeline that deploys problem infrastructure into each team's
account, a scoreboard, and per-team portals. TenkaCloud ships all four as one
open-source platform.

| If you need to… | …TenkaCloud gives you |
| --- | --- |
| Run a one-off internal cloud drill | **Lite mode** — Application Admin Console + Participant Portal + deploy backend, no multi-tenant setup |
| Deploy real AWS infrastructure per team | CloudFormation is created directly inside each team's isolated AWS environment using AssumeRole + a per-tenant ExternalId |
| Add new scenarios quickly | A **problem plugin model** — drop in `metadata.json` + `template.yaml` (and optional portal UI) and the platform picks it up |
| Keep costs predictable | A CDK Aspect pins every DynamoDB table to 1 RCU / 1 WCU PROVISIONED, designed for near-zero idle cost |
| Run it as a recurring program | **SaaS mode** — SBT-based control plane, pooled and silo tenant tiers, Cognito, EventBridge, and a per-tenant provisioning pipeline |

## Self-host vs operated

The platform itself is Apache 2.0 — **self-hosting on your own AWS account is
free**. Three optional paid plans exist for organizations that want setup, day-of
operations, or a recurring program run for them: **Starter** (one pilot event),
**Hosted Event** (a single operated event), and **Annual Arena** (an annual
program with multiple events per year). Details on the [landing page](https://susumutomita.github.io/TenkaCloud/#pricing).

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

A high-level visual overview of the platform's example competitions also lives in the [Competition Gallery](./docs/gallery.md).

## Create Your First Problem

Problem authoring happens in the catalog repo, not here. A problem is a self-contained directory under `battles/<id>/` or `challenges/<id>/` in that repo:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed to the team's isolated AWS environment
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

- **Control Plane** — SBT tenant management, EventBridge bus, tenant pipeline.
- **Application Plane** — tenant admin console, participant portal, Cognito, APIs.
- **Problem Deploy Plane** — deploy worker that assumes the per-tenant role and
  creates CloudFormation stacks inside each team's isolated AWS environment.
- **Trust Bridge** — `@TenkaCloud/trust-bridge` Cloud Action Intent protocol that
  translates a signed deploy intent into short-lived AWS credentials, so the
  platform never holds long-lived keys for a team's account.

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
