<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS
competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team
AWS Console federation from one application; participants solve real AWS scenarios in
isolated accounts.

[Landing page](https://tenkacloud.com) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Problem catalog](#problem-catalog) · [Architecture](#architecture)

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

## ▶ Try it — no AWS account, no install

| What you do | Link |
| --- | --- |
| Click through a live demo in your browser — simulated data, no backend, no AWS | **[Open the demo →](https://tenkacloud.com/portal-demo/?demo=1)** |
| Deploy Lite mode into your own AWS account | [Quickstart ↓](#quickstart) |

**New here?** Start at the top rung — see TenkaCloud working before installing anything.

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
| **Challenge** | Self-paced AWS tasks and service-specific labs | Flag / answer submission |
| **Battle** | Real-time operations drills | Health probes, phased polling, attack detection, or other catalog-declared scoring |

## Quickstart

Most organizers should start with **Lite mode**. It deploys one local tenant and one
event runtime into your AWS account, skipping the full SBT control plane.

| Path | Best for | What runs |
| --- | --- | --- |
| [A. AWS Console (no local install)](#a-aws-console-no-local-install) | You do not want to install Bun / CDK locally | CloudFormation creates a CodeBuild project; you press **Start build** and it git-clones the repo + catalog and runs `make deploy` |
| [B. Local terminal](#b-local-terminal) | You are comfortable running commands locally | Your shell runs `make deploy` |
| [C. SaaS mode](#c-saas-mode-optional) | Multi-tenant SaaS / pooled and silo tenants | Your shell runs `make deploy-saas` |

### A. AWS Console (no local install)

Because TenkaCloud is a public OSS repo, this path needs **no GitHub connection** — a
CodeBuild project git-clones the repo directly. CloudFormation needs the template hosted
in S3, so the no-local path is to upload it in the console.

1. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
2. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template)
   in `ap-northeast-1`.
3. Choose **Upload a template file**, upload `lite-pipeline.yaml`, and use
   `tenkacloud-lite` as the stack name.
4. Fill in the parameters:

   | Parameter | Required | Value |
   | --- | --- | --- |
   | `TenantAdminEmail` | Yes | Initial Application Admin Console user email |
   | `ProblemsRepoUrl` | No | Problem catalog to ship. Default is the official TenkaCloudChallenge; set your own fork to deploy your own problems |
   | `RepoUrl` / `RepoRef` | No | Platform repo + branch/tag (default: this repo's `main`); override for a fork |
   | `ProblemsRepoRef` | No | Catalog branch/tag (default `main`) |
   | `DeployExternalId` | No | Set only when you are ready to deploy into competitor accounts |

5. Acknowledge IAM changes and create the stack.
6. Open the **CodeBuild project** (the stack's `StartBuildConsoleUrl` output) and press
   **Start build**. The deploy takes about 15-30 minutes.
7. When the build finishes, the Application Admin Console and Participant Portal URLs are
   in the CloudFormation **Outputs** of the `tenkacloud-lite` stacks.

> **Deploy your own problems:** fork
> [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) (it ships the
> authoring tooling — `scripts/new-problem.ts`, the schema, and validation), author your
> problems there, then set `ProblemsRepoUrl` to your fork. No platform fork needed.

Full notes live in
[`infrastructure/templates/README.md`](./infrastructure/templates/README.md).

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

Teardown is:

```bash
make destroy
```

### C. SaaS mode (optional)

Use SaaS mode only when you need tenant onboarding, pooled tiers
(BASIC / ADVANCED), silo tenants (PLATINUM), and the SBT control plane.

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

The pinned catalog is a deliberately curated starter set — trimmed to high-quality,
hand-reviewed Battle and Challenge scenarios rather than padded with low-value labs.
Because the catalog lives in its own repo and advances independently of this platform
repo, the always-current contents (categories, scenarios, and bundles) are listed in
`problems/CATALOG.md` inside the submodule — check there for what is in the pinned set.

Useful catalog entry points:

- [`problems/CATALOG.md`](./problems/CATALOG.md) — source of truth for the full catalog.
- Authoring lives in the catalog repo [susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge).

## Create or update a problem

Problem authoring happens in the catalog repo. A problem directory contains:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed to the team's isolated AWS account
portal/          # optional React components for the Participant Portal
services/        # optional in-stack code or payloads
```

Scaffolding, the schema, and the authoring CLI live in that catalog repo
([susumutomita/TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)).
Open a catalog PR there, then bump this repo's `problems/` submodule pointer after the
catalog PR merges.

## Architecture

TenkaCloud has four planes that talk through an EventBridge bus:

| Plane | What it owns |
| --- | --- |
| **Control Plane** | SaaS tenant onboarding, pooled / silo tenant routing, and SBT integration |
| **Application Plane** | Tenant Admin Console, Cognito, runtime config, and per-tenant app data |
| **Problem Deploy Backend** | Cross-account problem deploy jobs, state machines, worker Lambdas, audit, and EventBridge reconciliation |
| **Participant Portal** | Per-team UI: problem endpoints, hints, submissions, scores, and AWS Console federation |

The directory map and architecture invariants live in [`CLAUDE.md`](./CLAUDE.md) and
[`AGENTS.md`](./AGENTS.md); the invariant checks are implemented under
[`.claude/harness/`](./.claude/harness/).

## Development commands

| Command | Purpose |
| --- | --- |
| `make install` | Install Bun workspace dependencies with lifecycle scripts disabled, then bootstrap Husky |
| `make build` | Build infrastructure, SPAs, and shared packages |
| `make typecheck` | Run TypeScript type checks across workspaces |
| `make test` | Run Vitest across workspaces |
| `make harness` | Run architecture invariant checks |
| `make before-commit` | Full local quality gate used before opening a PR |

Toolchain source of truth is `mise.toml` and `package.json`: Bun 1.3.11,
Node.js 24, AWS CDK 2, React 19, Vite 7, Hono on Lambda, DynamoDB, EventBridge,
Step Functions, CloudFront, Cognito, Vitest, Biome, markdownlint, and textlint.

## Self-hosting

The platform is Apache-2.0 and can be self-hosted in your own AWS account.

## Contributing

Contributor path:

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Keep infrastructure / template changes separate from application-code changes.
3. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
