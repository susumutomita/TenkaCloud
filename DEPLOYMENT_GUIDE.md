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

Tear down with `make destroy-saas`.
