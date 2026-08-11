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

## Always-On mode

Use Always-On mode when you run a recurring or long-running program and the goal is
**zero always-on AWS compute between events** — Lite mode and SaaS mode both keep
their control plane running continuously; Always-On mode does not. It is not one
`make` target: it ships as independent pieces, deployed and torn down per event.

- **Control plane** — the Cloudflare Worker `apps/always-on-control-plane` (D1 store:
  events / teams / score summaries / the Auth0-org→tenant projection). Organizer auth
  is Auth0 (RS256 JWKS); participants use SHA-256-hashed team keys. Deployed via the
  `deploy-always-on-control-plane.yml` workflow; manual approval is enforced only when the selected
  GitHub Environment has required reviewers (branch restrictions are a separate deployment gate).
- **Command seam** — the Worker mints a short-lived ES256 OIDC token, assumes the
  account-gated `tenkacloud-alwayson-command` role with web identity, and publishes the
  frozen deploy event to one EventBridge bus. Provision that trust once with
  `make deploy-always-on-command`; there is no long-lived AWS key or verifier Lambda.
- **Per-event runtime** — a per-event CDK stack (`bin/tenkacloud-always-on-runtime.ts`,
  stack id `tenkacloud-event-runtime-<eventId>`) deployed and destroyed by the
  `deploy-always-on-runtime.yml` / `destroy-always-on-runtime.yml` workflows (GitHub
  OIDC, no long-lived keys). It exists only during an event.

The current deployment inputs and command surface are defined by the
`deploy-always-on-*` / `destroy-always-on-*` workflows and the corresponding
`Makefile` targets.

### Always-On operator runbook

Keep this section as the stable operator entry point. Exact environment-variable names and
preflight checks live in the workflows, `wrangler.jsonc`, and `Makefile`; update those executable
contracts and this checklist together.

#### One-time control-plane setup

1. Create an Auth0 Custom API that signs access tokens with RS256. Organizer tokens must carry
   `org_id` and the namespaced roles claim configured by `AUTH0_ROLES_CLAIM`; accepted roles are
   `TenantAdmin`, `TenantOperator`, and `TenantViewer`. Confirm that the selected Auth0 plan
   provides the organization-role lifecycle you use, or emit the claim from a separately reviewed
   Auth0 Action; do not assume role management is present.
2. Replace every deployment placeholder in
   `apps/always-on-control-plane/wrangler.jsonc`: the Auth0 issuer/audience/client ID, the exact
   HTTPS `MCP_CANONICAL_ORIGIN`, AWS command role/region/bus, problem catalog, and each D1 database
   ID. Create the environment-specific D1 databases with Wrangler before pasting their IDs. Set
   `COMMAND_ROLE_ARN` to the deterministic role ARN
   `arn:aws:iam::<account-id>:role/tenkacloud-alwayson-command`; step 7 creates that role. Never put
   an Auth0 secret, Cloudflare token, or signing key in this file.
3. In the `cloudflare-staging` and `cloudflare-production` GitHub Environments, configure
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Configure required reviewers when deployment
   requires manual approval, and restrict deployment branches separately.
4. From `apps/always-on-control-plane`, create distinct Worker secrets for each environment:

   ```bash
   bunx wrangler secret put SYSTEM_ADMIN_TOKEN --env staging
   bunx wrangler secret put RUNTIME_FEED_TOKEN --env staging
   ```

   Repeat for production with independently generated values. The runtime-feed token must also be
   stored as an AWS SSM SecureString; place only that parameter name in
   `ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER`.
5. Generate the OIDC signing secret as a P-256 private JWK without writing it to the repository or
   shell history. One suitable Node 20+ flow is:

   ```bash
   node --input-type=module <<'NODE' | bunx wrangler secret put OIDC_SIGNING_PRIVATE_JWK --env staging
   const pair = await crypto.subtle.generateKey(
     { name: "ECDSA", namedCurve: "P-256" },
     true,
     ["sign", "verify"],
   );
   console.log(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
   NODE
   ```

   Repeat with an independent key for production. The Worker derives the public JWKS. To rotate
   the key, replace the secret, deploy the Worker, then verify one deploy command end to end. Do
   not upload a public-key copy to SSM; retain the previous private key securely through the
   rollback window.
6. Run the `deploy-always-on-control-plane` workflow for staging. It applies D1 migrations before
   deployment. Verify the Worker origin serves its OIDC discovery document and JWKS, then repeat
   the setup and deployment for production.
7. Provision the AWS command trust. The default `CommandRoleArnOutput` must equal the deterministic
   `COMMAND_ROLE_ARN` configured in step 2:

   ```bash
   make deploy-always-on-command \
     CDK_PARAM_AWS_ACCOUNT_ID=<aws-account-id> \
     CDK_PARAM_AWS_REGION=<aws-region> \
     CDK_PARAM_ALWAYS_ON_ISSUER_URL=https://<worker-origin> \
     CDK_PARAM_EVENT_BUS_ARN=arn:aws:events:<region>:<account>:event-bus/<deploy-bus>
   ```

   If you override `CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME`, update `COMMAND_ROLE_ARN` and rerun the
   control-plane workflow before testing a command.
8. Set the tenant projection through
   `PUT /v1/system/tenant-auth-projections/{orgId}` and register every tenant-owned competitor
   account through `PUT /v1/system/competitor-accounts/{tenantId}/{awsAccountId}`, authenticating
   both calls with `SYSTEM_ADMIN_TOKEN`. The JSON bodies are `{ "tenantId": "...", "suspended":
   false }` and `{ "competitorRoleArn": "...", "externalIdParameterName": "..." }`, respectively.
   Suspension is checked from the projection on every organizer request; do not rely on a token
   claim for revocation.

#### Per-event setup and teardown

Bootstrap the workflow role once in the target AWS account. Pin its OIDC subject to the protected
GitHub Environment used below:

```bash
make deploy-always-on-runtime-role \
  CDK_PARAM_AWS_ACCOUNT_ID=<aws-account-id> \
  CDK_PARAM_AWS_REGION=<aws-region> \
  CDK_PARAM_GITHUB_OIDC_SUBJECT='repo:susumutomita/TenkaCloud:environment:always-on-runtime'
```

If the account already has the GitHub Actions OIDC provider, also pass its ARN as
`CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN`. Copy `DeployRoleArnOutput` to the protected
`always-on-runtime` GitHub Environment as the `ALWAYS_ON_DEPLOY_ROLE_ARN` secret. Configure these
variables in the same Environment:

- `ALWAYS_ON_DEPLOYMENTS_TABLE_NAME`
- `ALWAYS_ON_EVENTS_TABLE_NAME`
- `ALWAYS_ON_ENDPOINTS_TABLE_NAME`
- `ALWAYS_ON_CONTROL_PLANE_URL`
- `ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER`
- `ALWAYS_ON_ARCHIVE_BUCKET_NAME` (an existing private bucket with S3 Block Public Access enabled;
  the runtime imports this bucket by name and does not create or harden it)
- optional `ALWAYS_ON_DISRUPTIONS_TABLE_NAME` and `ALWAYS_ON_EVENT_BUS_NAME`

Before participant access, confirm the Cloudflare account plan supports the expected event load,
then run the staging smoke and concurrency tests. Deploy an event with the
`deploy-always-on-runtime` workflow, supplying `eventId`, `tenantId`, `expiresAt`, and `awsRegion`.
Monitor Worker request/error/CPU metrics and D1 usage during the event.

After the event, run `destroy-always-on-runtime` with the same identifiers. The workflow archives
that event's raw score rows before deleting its runtime stack; an archive failure stops deletion so
it can be retried. There is no nightly cleanup safety net, so verify the
`tenkacloud-event-runtime-<eventId>` stack is gone. Retain D1 and the previous Worker version through
the rollback window.

#### Rollback

Run the rollback from the Worker workspace and select the affected environment explicitly:

```bash
cd apps/always-on-control-plane
bunx wrangler rollback --env staging
```

Use `--env production` for production. The repository does not automate or verify a DNS/API-origin
switch; use it only when the external routing procedure has been tested separately, and otherwise
record traffic rollback as unavailable. Do not delete D1 while the old path may still need its data.
A signing-key rollback requires restoring the previous private JWK secret and redeploying before
retrying commands.
