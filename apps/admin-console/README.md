# @TenkaCloud/admin-console

SPA used by the System Admin in SaaS mode to operate the Control Plane (the `ControlPlane` construct from [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws) 0.3.9). Built with Vite + React + Cloudscape Design System. Authentication is OAuth Code + PKCE through the Cognito Hosted UI.

> Lite mode (= `make deploy`) does not use this SPA — it is SaaS-mode-only. For the single-operator, single-competition path, use `apps/application-admin-console` directly via `make deploy`.

## Features

- Sign-in through the Cognito Hosted UI (TOTP MFA required)
- Tenant list / create / deprovision
- Provisioning jobs (CodePipeline execution history)
- Audit log
- Operations dashboard (deep links to CloudWatch Dashboard / AWS Budgets / Alarms)
- Usage dashboard — tenant usage visualization (`src/pages/Usage.tsx`, #1767)
- Identity providers — SAML SSO IdP CRUD for the Control Plane Cognito UserPool (`src/pages/IdentityProviders.tsx`, #1293)

i18n: Japanese and English.

## Local development

Create `.env.local` first, then start the dev server.

```env
VITE_COGNITO_DOMAIN=https://tenkacloud-xxxx.auth.ap-northeast-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_API_BASE_URL=https://xxxxx.execute-api.ap-northeast-1.amazonaws.com/prod
```

```sh
make install
make dev
# → http://localhost:5173
```

Add `http://localhost:5173/callback` as an allowed callback URL on the Cognito UserPoolClient (CDK adds this automatically after `make deploy-saas`). In production builds, the URL is injected via `runtime-config.json`, so `.env.local` is not needed.

## Commands

```sh
make dev      # dev server
make build    # type-check + production build
make preview  # serve dist/
make test     # vitest
```
