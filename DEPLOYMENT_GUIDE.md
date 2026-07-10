# TenkaCloud — Deployment guide

The recommended path is in the [README Quickstart](./README.md#quickstart): deploy Lite
mode from the AWS Console, no local install. This guide covers the other paths.

## What gets deployed (Lite mode)

Lite mode deploys the application plane with `tenantId="local"`:

- **Application Admin Console** — organizers create events, register teams, select
  problems, start deploy jobs, and watch progress.
- **Participant Portal** — teams read instructions, open hints, submit flags, view
  scores, and federate into their own AWS account.
- **Problem deploy backend** — DynamoDB, Lambda, Step Functions, EventBridge, and audit
  records for deploying catalog templates into competitor accounts. The default deploy
  path is Lambda CreateStack + poll — `deployViaLambda` defaults to `true` in
  `infrastructure/lib/app-config/resolve.ts`. A CodeBuild project is only synthesized
  when you explicitly set `CDK_PARAM_DEPLOY_VIA_LAMBDA=false`; see
  `infrastructure/lib/problem-deploy/build-deploy-pipeline.ts`.

## Lite mode — local terminal

Use this when you can install the repo toolchain (Bun / CDK) locally.

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make env-init    # creates infrastructure/environments/development/.env
make deploy
```

`make env-init` prompts for the required Lite-mode values. To set them by hand instead:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID, AWS_REGION, and TENANT_ADMIN_EMAIL
```

Tear down with `make destroy`.

## SaaS mode (multi-tenant)

Use SaaS mode only when you need tenant onboarding, pooled tiers (BASIC / ADVANCED),
silo tenants (PLATINUM), and the SBT control plane.

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit SYSTEM_ADMIN_EMAIL, AWS_ACCOUNT_ID, and AWS_REGION

make deploy-saas
```

Tear down with `make destroy-saas`. The three-phase orchestration is documented in
[CLAUDE.md](./CLAUDE.md).

## Always-On mode (ADR-049)

Use Always-On mode when you run a recurring or long-running program and the goal is
**zero always-on AWS compute between events** — Lite mode and SaaS mode both keep
their control plane running continuously; Always-On mode does not. It is not one
`make` target: it ships as independent pieces, deployed and torn down per event.

- **Control plane** — the Cloudflare Worker `apps/always-on-control-plane` (D1 store:
  events / teams / score summaries / the Auth0-org→tenant projection). Organizer auth
  is Auth0 (RS256 JWKS); participants use SHA-256-hashed team keys. Deployed via the
  manual-approval `deploy-always-on-control-plane.yml` GitHub Actions workflow.
- **Command seam** — the Worker mints ES256-signed `CloudActionIntent`s
  (`packages/trust-bridge`) and POSTs them to the AWS **signed-intent ingress**, a
  Lambda Function URL with zero idle compute (`make deploy-always-on-ingress`), which
  verifies and scope-authorizes them, then re-emits the frozen deploy events onto the
  existing EventBridge bus.
- **Per-event runtime** — a per-event CDK stack (`bin/tenkacloud-always-on-runtime.ts`,
  stack id `tenkacloud-event-runtime-<eventId>`) deployed and destroyed by the
  `deploy-always-on-runtime.yml` / `destroy-always-on-runtime.yml` workflows (GitHub
  OIDC, no long-lived keys). It exists only during an event.

Full operator runbook (Cloudflare bootstrap, Auth0 contract, signing-key rotation,
score-feed wiring, rollback) lives in
[docs/always-on/README.md](./docs/always-on/README.md). Design background is
[ADR-049](./docs/architecture/adr-049-always-on-cloudflare-control-plane.html).
