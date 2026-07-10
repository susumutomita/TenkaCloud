# @TenkaCloud/application-admin-console

Application Plane admin console used by the Tenant Admin (the competition operator). Handles deploying Battle / Challenge problems to competitor AWS accounts, managing Events, and supporting operators during a competition. The same SPA runs in both Lite mode (the `make deploy` default) and SaaS mode (`make deploy-saas`).

## Features

- **Event management** — create / list / detail (deploy progress, team ranking)
- **Problem catalog** — browse / detail / assign to an Event
- **Deploy progress** — Step Functions + CodeBuild execution visualization
- **Competitor accounts** — register competitor AWS accounts and re-issue ExternalId
- **Teams / SSO credentials** — issue per-team login keys for each Event
- **Settings** — per-tenant runtime feature-flag toggles (`src/pages/Settings.tsx`, #2231/#2305)
- **Audit log** — this tenant's own operation history (deploy / event / user actions), scoped to the tenant only
- **Identity providers** — SAML IdP CRUD for this tenant's Cognito UserPool (silo tier only)
- **Tenant users** — invite / list / change role / remove users within this tenant

i18n: Japanese and English.

## Local development

```sh
make install
make dev
# → http://localhost:5174
```

In dev mode, `runtime-config.json` is not fetched — values are read from `import.meta.env.VITE_*`. In production, the source of truth is `/runtime-config.json` served from CloudFront.

## Commands

```sh
make dev      # dev server
make build    # type-check + production build
make preview  # serve dist/
make test     # vitest
make clean    # remove dist and node_modules
```

From the monorepo root:

```sh
bun run --filter @TenkaCloud/application-admin-console dev
bun run --filter @TenkaCloud/application-admin-console test
```

## See also

- [`/problems/`](../../problems/) — problem catalog
- [`CLAUDE.md`](../../CLAUDE.md) / [`AGENTS.md`](../../AGENTS.md) — architecture and project rules
