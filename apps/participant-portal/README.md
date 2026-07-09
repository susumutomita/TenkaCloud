# @TenkaCloud/participant-portal

Web portal for TenkaCloud competitors. Authentication is via a short-lived per-team login key; the portal provides click-through access to problems deployed for that team. The main views are scoreboard / score events / operator notifications.

Competitors solve problems in the AWS Console, so the portal minimizes hosting cost: **static S3 + CloudFront hosting** + **Lambda backend**.

## Features / pages

- `/login` — sign in with the team login key
- `/` — Home (welcome + event info + cumulative score + quick links to problems)
- `/problems` — Quests list (filter by Battle / Challenge category and submission state)
- `/problems/:jobId` — problem detail (`metadata.json` narrative + flag submission + endpoint override + portal plugin slot)
- `/scoreboard` — Scoreboard with real-time ranking (5-second polling); frozen 30 minutes before competition end
- `/score-events` — Your team's score-change history with a cumulative score line chart
- `/notifications` — Operator notifications (info / warning)
- `/sso` — SSO Credentials for one-click federated sign-in to the AWS Console

i18n: Japanese and English.

## Authentication

- Enter the per-team **login key** (issued by the deploy backend when the Event is created). The backend matches it against DynamoDB and issues a session token.
- No per-user accounts are created — operators are not responsible for personal-information management.
- Dev mode bypasses the backend and uses a mock validator (`mode=dev-mock` in `runtime-config.json`).

## Local development

```sh
make install
make dev
# → http://localhost:5175
```

`make dev` writes a `dev-mock` `runtime-config.json`, so any non-empty team login
key signs in without a backend. For the local scoring API and Docker-backed problems,
run `make local` from the repo root first, then start this portal with
`make local-portal`; that mode also accepts any non-empty key, but the portal calls
the local API.

`make help` lists the available targets.

## Commands

```sh
make dev      # dev server
make build    # type-check + production build
make preview  # serve dist/
make test     # vitest
```

## See also

- [`/problems/`](../../problems/) — problem catalog
