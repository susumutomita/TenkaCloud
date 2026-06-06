<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS
competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team
AWS Console federation from one application; participants solve real AWS scenarios in
isolated accounts.

[Landing page](https://susumutomita.github.io/TenkaCloud/) · [Demo portal](https://susumutomita.github.io/TenkaCloud/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Problem catalog](#problem-catalog) · [Architecture](#architecture)

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

</div>

> TenkaCloud is an independent open-source project and is not affiliated with,
> endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are
> trademarks of Amazon.com, Inc. or its affiliates.

---

## What TenkaCloud gives you

TenkaCloud turns a problem catalog into a live cloud drill:

1. **Create an event** in the Application Admin Console.
2. **Select problems** from the catalog submodule (`problems/`).
3. **Register teams** and their AWS account trust settings.
4. **Deploy problem stacks** into each team's isolated AWS account with
   cross-account `AssumeRole` + required `ExternalId`.
5. **Run the event**: participants use the portal for instructions, hints,
   submissions, scores, and one-click AWS Console federation.

Two problem styles share the same runtime:

| Style | Use it for | Scoring model |
| --- | --- | --- |
| **Challenge** | Self-paced AWS tasks and certification-style labs | Flag / answer submission |
| **Battle** | Real-time operations drills | Health probes, phased polling, attack detection, or other catalog-declared scoring |

## Quickstart

Most organizers should start with **Lite mode**. It deploys one local tenant and one
event runtime into your AWS account, skipping the full SBT control plane.

| Path | Best for | What runs |
| --- | --- | --- |
| [A. AWS Console pipeline](#a-aws-console-pipeline-no-local-install) | You do not want to install Bun / CDK locally | CloudFormation creates CodePipeline + CodeBuild; CodeBuild runs `make deploy` |
| [B. Local terminal](#b-local-terminal) | You are comfortable running commands locally | Your shell runs `make deploy` |
| [C. Docker](#c-docker-only-docker-on-the-host) | You have only Docker on the host (no Bun / Node) | A toolchain container runs `make deploy` |
| [D. SaaS mode](#d-saas-mode-optional) | Multi-tenant SaaS / pooled and silo tenants | Your shell runs `make deploy-saas` |

### A. AWS Console pipeline (no local install)

CloudFormation quick-create buttons require the template file to be hosted in Amazon
S3. This repository stores the template in GitHub, so the reliable no-local path is
to download the template and upload it in the CloudFormation console.

1. Create a GitHub connection first:
   AWS Console → **Developer Tools** → **Connections** → **Create connection** →
   GitHub → finish the OAuth flow → copy the connection ARN.
2. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
3. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template)
   in `ap-northeast-1`.
4. Choose **Upload a template file**, upload `lite-pipeline.yaml`, and use
   `tenkacloud-lite-pipeline` as the stack name.
5. Fill in the parameters:

   | Parameter | Required | Value |
   | --- | --- | --- |
   | `TenantAdminEmail` | Yes | Initial Application Admin Console user email |
   | `GitHubConnectionArn` | Yes | Connection ARN from step 1 |
   | `GitHubRepositoryId` | No | Keep `susumutomita/TenkaCloud`, or set your fork as `owner/repo` |
   | `SourceBranchName` | No | Branch to deploy; default is `main` |
   | `EnableManualApproval` | No | Keep `true` to approve the pipeline run before deploy |
   | `DeployExternalId` | No | Set only when you are ready to deploy into competitor accounts |

6. Acknowledge IAM changes and create the stack. The pipeline starts immediately;
   approve the manual approval action if you left it enabled.
7. When CodeBuild finishes, the build log prints the Application Admin Console and
   Participant Portal URLs.

Full pipeline notes live in
[`infrastructure/templates/README.md`](./infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline).

### B. Local terminal

Use this path when you can install the repo toolchain locally.

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make env-init
make deploy
```

`make env-init` creates `infrastructure/environments/development/.env` and prompts
for the required Lite-mode values. If you prefer manual setup, copy the example file
and edit it yourself:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID, AWS_REGION, and TENANT_ADMIN_EMAIL
```

After deploy, use these helpers:

```bash
make lite-status
make lite-console-url
make lite-portal-url
```

Teardown is:

```bash
make destroy
```

### C. Docker (only Docker on the host)

Use this path on a machine that has only Docker — no Bun, Node, or AWS CLI. The
toolchain rides in a container; the repo and your AWS credentials are mounted in.

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud

cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID, AWS_REGION, and TENANT_ADMIN_EMAIL

make deploy-docker     # builds the image (first run), installs deps, runs `make deploy`
```

AWS auth is automatic: run `aws sso login` (or `aws configure`) on the host first, then
`make deploy-docker` reads your `~/.aws` (mounted read-only) — no `AWS_PROFILE` to set.
Static or temporary keys in your shell (`AWS_ACCESS_KEY_ID` etc.) are inherited too.
Pick the environment with `make deploy-docker ENV=production`. Teardown is
`make destroy-docker`, and `make docker-shell` opens a shell in the toolchain container.
See [`docker-compose.yml`](./docker-compose.yml) and [`docker/Dockerfile`](./docker/Dockerfile).

### D. SaaS mode (optional)

Use SaaS mode only when you need tenant onboarding, pooled tiers
(BASIC / STANDARD / PREMIUM), silo tenants (PLATINUM), and the SBT control plane.

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit SYSTEM_ADMIN_EMAIL, AWS_ACCOUNT_ID, and AWS_REGION

make deploy-saas
```

Teardown is:

```bash
make destroy-saas
```

## What gets deployed

Lite mode deploys the same application plane used by SaaS mode, but with
`tenantId="local"`:

- **Application Admin Console** — organizers create events, register teams, select
  problems, start deploy jobs, and watch progress.
- **Participant Portal** — teams read problem instructions, open hints, submit flags,
  view scores, and federate into their own AWS account.
- **Problem deploy backend** — DynamoDB, Lambda, Step Functions, CodeBuild,
  EventBridge, and audit records for deploying catalog templates into competitor
  accounts.

## Problem catalog

Problems live in the separate catalog repo
[susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge).
This platform repo mounts it as the `problems/` git submodule; `make deploy` ships the
catalog version pinned by that submodule.

The current pinned catalog contains **112 public problems**:

| Category | Count | Notes |
| --- | ---: | --- |
| Challenge | 108 | AWS certification-style and service-specific tasks, all scored with catalog-declared flags / answers |
| Battle | 4 | Real-time operations drills for uptime, migration, attack response, and production hardening |
| Bundles | 1 | `starter-event`, a first-event bundle for new organizers |

Useful catalog entry points:

- [`problems/CATALOG.md`](./problems/CATALOG.md) — source of truth for the full catalog.
- [`problems/CERTIFICATION-INDEX.md`](./problems/CERTIFICATION-INDEX.md) — maps labs to AWS certification domains.
- [`docs/gallery.md`](./docs/gallery.md) — platform-side gallery and walkthrough notes.
- [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — 30-minute authoring guide.

## Create or update a problem

Problem authoring happens in the catalog repo. A problem directory contains:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed to the team's isolated AWS account
portal/          # optional React components for the Participant Portal
services/        # optional in-stack code or payloads
```

The platform repo still owns the scaffolding CLI because it depends on shared
TypeScript packages:

```bash
bun run scripts/tenkacloud-problem.ts create my-first-challenge --kind flag
bun run scripts/tenkacloud-problem.ts validate my-first-challenge
```

Move the generated problem into your local clone of
[susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge),
open a catalog PR, and then bump this repo's `problems/` submodule pointer after the
catalog PR merges.

## Architecture

TenkaCloud has three planes:

| Plane | What it owns |
| --- | --- |
| **Control Plane** | SaaS tenant onboarding, pooled / silo tenant routing, and SBT integration |
| **Application Plane** | Tenant Admin Console, Participant Portal, Cognito, runtime config, and per-tenant app data |
| **Problem Deploy Backend** | Cross-account problem deploy jobs, state machines, worker Lambdas, audit, and EventBridge reconciliation |

![TenkaCloud Lite demo flow](./docs/assets/tenkacloud-lite-demo.svg)

Start with these docs:

- [`docs/architecture/OVERVIEW.md`](./docs/architecture/OVERVIEW.md) — end-to-end architecture narrative.
- [`docs/architecture/MODULE_MAP.md`](./docs/architecture/MODULE_MAP.md) — directory and module map.
- [`docs/architecture/GLOSSARY.md`](./docs/architecture/GLOSSARY.md) — terms with ADR back-links.
- [`CONTRIBUTOR_MAP.md`](./CONTRIBUTOR_MAP.md) — "I want to do X" navigation.

Key ADRs:

- [ADR-012: Problem plugin architecture](./docs/architecture/adr-012-problem-plugin-architecture.html)
- [ADR-016: TenkaCloud Lite mode](./docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html)
- [ADR-017: Cloud Action Intent / Trust Bridge](./docs/architecture/adr-017-cloud-action-intent-trust-bridge.html)

## Development commands

| Command | Purpose |
| --- | --- |
| `make install` | Install Bun workspace dependencies with lifecycle scripts disabled, then bootstrap Husky |
| `make build` | Build infrastructure, SPAs, and shared packages |
| `make typecheck` | Run TypeScript type checks across workspaces |
| `make test` | Run Vitest across workspaces |
| `make validate-problems` | Validate the pinned catalog submodule |
| `make harness` | Run architecture invariant checks |
| `make before-commit` | Full local quality gate used before opening a PR |

Toolchain source of truth is `mise.toml` and `package.json`: Bun 1.3.11,
Node.js 24, AWS CDK 2, React 19, Vite 7, Hono on Lambda, DynamoDB, EventBridge,
Step Functions, CloudFront, Cognito, Vitest, Biome, markdownlint, and textlint.

## Self-hosting and operated options

The platform is Apache-2.0 and can be self-hosted in your own AWS account. Optional
commercial support is documented separately:

- [`docs/commercial/PACKAGES.html`](./docs/commercial/PACKAGES.html) — packaged offerings.
- [`docs/commercial/SALES-PLAYBOOK.html`](./docs/commercial/SALES-PLAYBOOK.html) — positioning, qualifying questions, and objections.

## Contributing

Contributor path:

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Use [CONTRIBUTOR_MAP.md](./CONTRIBUTOR_MAP.md) to find the right code area.
3. Keep infrastructure / template changes separate from application-code changes.
4. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
