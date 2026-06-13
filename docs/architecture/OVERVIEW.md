# TenkaCloud Architecture Overview

> 10-minute read for first-time contributors. For the "what to do" perspective, jump to [CONTRIBUTOR_MAP.md](../../CONTRIBUTOR_MAP.md). For module-level "where is X" lookups, see [MODULE_MAP.md](./MODULE_MAP.md). For term definitions with ADR back-links, see [GLOSSARY.md](./GLOSSARY.md). Decisions and their rationales live in [`adr-*.html`](.) — this document does **not** duplicate ADR content.

TenkaCloud is a multi-tenant SaaS cloud-competition platform on AWS. Operators ("organizers") run events. Each event hosts teams of competitors who deploy AWS CFn stacks into their own AWS accounts under controlled supervision, and earn points based on the resulting state (flag submission, endpoint uptime, attack detection, etc).

## The two deploy modes

The codebase ships **two** deploy entry points. They share the same Lambdas and 5 problem-scoring kinds. They differ in how many tenants they support and how much SBT machinery they bring up.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   make deploy        →     Lite mode                                         │
│   (default)               • single tenantId="local"                          │
│                           • 2 stacks: AppPlaneCore + ProblemDeployBackend    │
│                           • ~10 min boot                                     │
│                           • use case: 1 organizer, 1 event, fastest path     │
│                                                                              │
│   make deploy-saas   →     SaaS mode                                         │
│                           • SBT ControlPlane (pooled + silo tiers)           │
│                           • 5+ stacks (control plane, bootstrap, tenant      │
│                             template, pipeline, problem-deploy, admin UIs)   │
│                           • 3-phase install (control plane → admin UI →      │
│                             callback wiring)                                 │
│                           • use case: multi-organizer SaaS                   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Same code, two entry points. Lite mode is the **default** because most events are one-organizer / one-event. SaaS mode kicks in when an organizer wants tier-based pooled vs siloed tenant isolation. The Lite vs SaaS choice is hidden behind `make deploy` vs `make deploy-saas`; everything downstream of "a tenant exists" is identical.

## The four planes

Once the platform is up, runtime traffic flows across four planes that talk through an EventBridge bus.

```
┌──────────────────────────────────────┐    ┌──────────────────────────────────┐
│  Control Plane                       │    │  Application Plane               │
│  • SBT ControlPlane construct        │    │  • per-tenant Cognito + API + UI │
│  • Cognito UserPool (SystemAdmin)    │    │  • pooled (BASIC/ADVANCED        │
│  • Tenant CRUD HTTP API              │    │    tiers) or silo                │
│  • admin-console UI                  │    │    (PLATINUM tier)               │
│  • EventBridge bus owner             │    │  • application-admin-console UI  │
└────────────────┬─────────────────────┘    └────────────────┬─────────────────┘
                 │                                            │
                 │              EventBridge bus               │
                 │ ◄────────────────────────────────────────► │
                 │     (onboardingRequest, DeployRequested,   │
                 │      DeployCompleted, ScoreUpdated, …)     │
                 │                                            │
┌────────────────┴─────────────────────┐    ┌────────────────┴─────────────────┐
│  Problem Deploy Backend              │    │  Participant Portal              │
│  • Deployments DDB + Worker Lambda   │    │  • per-team UI                   │
│  • AssumeRole into competitor AWS    │    │  • flag submission / endpoints   │
│  • CFn CreateStack per team          │    │  • Console SSO one-click login   │
│  • generic scoring dispatcher        │    │    (federation → AssumeRole)     │
│  • Step Functions for retry / delete │    │  • disruption display            │
└──────────────────────────────────────┘    └──────────────────────────────────┘
```

- **Control Plane** is the *tenant manager*. It does NOT host tenant runtime (= [`INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`](./harness.md)). It only knows "tenant X exists, tier=Y".
- **Application Plane** is the per-tenant runtime. Pooled tiers share one CDK stack, PLATINUM gets its own stack via the per-tenant pipeline.
- **Problem Deploy Backend** is the dangerous bit: it AssumeRoles into competitors' AWS accounts and runs CFn there. Every AssumeRole call requires `ExternalId` ([no exception, ever](../../infrastructure/templates/competitor-bootstrap.yaml)).
- **Participant Portal** is the public-facing per-team app. Competitors log in with a team key (no AWS account required from them) and click through to AWS Console via the federation flow in `sso.ts`.

These four planes are not microservices in the cloud-native sense — they're CDK stack boundaries within a single AWS account. The point of the separation is **deployment + IAM isolation**, not network isolation.

## TrustBridge: why one extra hop exists

When a deploy is requested, it crosses the most dangerous IAM boundary in the system: the platform's AWS account (where Lambdas run) → the **competitor's** AWS account (where the actual problem stack gets created). To make this auditable and to give the operator a "veto" point before the action runs, every deploy goes through **TrustBridge** (ADR-017).

```
Operator clicks "Deploy"
       │
       ▼
deploy-handler Lambda emits a CloudActionIntent (shadow audit)
       │
       ▼
TrustBridge logs the intent BEFORE AssumeRole happens
       │
       ▼
Worker Lambda AssumeRoles into competitor account using tenant's ExternalId
       │
       ▼
CFn CreateStack runs inside the competitor account with that problem's template
```

TrustBridge is currently in *shadow* mode: it emits structured audit logs without blocking. Phase 2/3 plans (ADR-017) flip it to enforcement, where high-risk actions require operator confirmation. The shadow mode is intentional — it lets us collect baseline data before adding friction.

## Problems = plugins

Problem templates do not live in this repo. They live in [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge), mounted as a Git submodule at `problems/`. The platform side is a generic *host* that knows how to deploy a CFn template, poll endpoints for uptime, count attacks, etc; the catalog repo brings the actual content (ADR-012).

```
[TenkaCloudChallenge repo]                    [This (platform) repo]
problems/                                     problems/                          ← git submodule pointer
  battles/<id>/                               infrastructure/lib/problem-deploy/ ← the generic host
    metadata.json    ← scoring + UI wiring      handlers/deploy-handler/         ← deploy chain
    template.yaml    ← CFn payload              handlers/generic-scoring-handler/← 5 builtin kinds
    portal/<slot>.tsx← optional UI slot         handlers/participant-handler/    ← portal API
    services/...     ← optional payload code
```

A new problem = a PR to the catalog repo + a `git submodule update --remote problems` bump here. No platform Lambda code changes. The host validates the metadata against `SCHEMA.json` (= source of truth for the contract between platform and catalog), then dispatches scoring based on `scoring.kind`.

There's a second, dormant path for content that shouldn't ship via OSS submodule: `ChallengePayloadStack` ([ADR-008](./adr-008-problem-payload-separation.html) Phase 3) provides an S3 + GitHub OIDC route where a private "answer" repo can publish per-problem zips and the deploy-handler fetches them via presigned URL. It's available but currently no repo binds the secret.

## Data isolation

There is **no** single-table DDB design in this repo. Each stack owns its own tables (TenantMappingTable / Deployments / Apps / CompetitorAccounts / Events / Teams / Disruptions / etc), and tenant isolation is enforced via either the `TenantId` partition key or by stack separation.

Every DDB table is forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect ([`DynamoDbLowCapacity`](../../infrastructure/lib/cdk-aspect/dynamodb-low-capacity.ts)) so the whole platform stays inside the AWS Free Tier 25 RCU/WCU budget. PAY_PER_REQUEST is explicitly forbidden — the Aspect will quietly override it.

## What's intentionally NOT in this overview

- **Specific scoring kinds** — see [ADR-012](./adr-012-problem-plugin-architecture.html) and the catalog repo's `SCHEMA.json`.
- **Auth model details** — see [ADR-020](./adr-020-authorization-model.html).
- **Per-tenant pipeline mechanics** — see [ADR-018](./adr-018-pooled-userpool-saml-isolation.html) + `serverless-saas-pipeline.ts`.
- **TrustBridge enforcement details** — see [ADR-017](./adr-017-cloud-action-intent-trust-bridge.html).
- **Disruption phase 2 (condition-triggered)** — see [ADR-013](./adr-013-disruption-phase2-condition-triggered.html).

All ADRs live alongside this file under `docs/architecture/adr-*.html`.
