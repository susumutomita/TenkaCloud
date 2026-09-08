# @TenkaCloud/participant-portal

Web portal for TenkaCloud competitors. Authentication is via a short-lived per-team login key; the portal provides click-through access to problems deployed for that team. The main views are scoreboard / score events / operator notifications.

Competitors solve problems in the AWS Console, so the portal minimizes hosting cost: **static S3 + CloudFront hosting** + **Lambda backend**.

## Features / pages

- `/login` — sign in with the team login key
- `/setup` — team-name onboarding, shown once to competitors who haven't set a team name yet (guarded by `RequireAuth requireTeamName={false}`)
- `/` — Home (welcome + event info + cumulative score + quick links to problems)
- `/problems` — Quests list (filter by Battle / Challenge category and submission state)
- `/problems/:jobId` — problem detail (`metadata.json` narrative + flag submission + endpoint override + portal plugin slot)
- `/scoreboard` — Scoreboard with real-time ranking (5-second polling); frozen 30 minutes before competition end
- `/score-events` — Your team's score-change history with a cumulative score line chart
- `/notifications` — Operator notifications (info / warning)
- `/tools/sso` — SSO Credentials for one-click federated sign-in to the AWS Console

i18n: Japanese and English.

## Plugin updates during a competition

While a problem plugin is open, the portal checks its problem-specific dependency fingerprint on mount,
every minute, and when the window regains focus. A changed problem or shared dependency shows a reload
notice without remounting the form or discarding unfinished answers. The reload
button explicitly discards unsent input. Plugin render errors also offer this
recovery action; they remain visible and logged rather than becoming success.

The build embeds a baseline map and emits `plugin-versions.json` from each problem's
module graph, stylesheet contents, and configured slot mapping. Removal of a
previously loaded plugin also triggers the notice. Detected updates are retained
across problem navigation and offline checks. Changes confined to another problem do not trigger a notice. This
does not change coordination data, scoring, or individual problem rules. A failed network check is retried;
it is not treated as evidence of an update. Serve the updated version manifest through
the normal deployment cache invalidation. Tabs running a build from before this
feature must be manually reloaded once to acquire the update checker.

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
key signs in without a backend. For the local scoring API and Docker-backed
problems, run `make local` from the repo root; that starts this portal in local
mode too. Its generated runtime config pre-fills a fresh random local team key;
the authenticated Simulator console handoff accepts only that session key.

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
