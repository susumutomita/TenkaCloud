# @TenkaCloud/cli

TenkaCloud CLI — Cognito OAuth (Authorization Code + PKCE + loopback) sign-in
plus API operation subcommands so operators can drive the platform from a
terminal / CI script without clicking through the web UI.

## Phase 1 — auth (Issue #988)

- `tenkacloud login` — open Cognito Hosted UI in the browser, capture the
  authorization code via a local loopback HTTP server
  (`http://127.0.0.1:<random>/callback`), exchange for ID / access / refresh
  tokens, persist to `~/.config/tenkacloud/credentials` (file mode `0600`).
- `tenkacloud logout` — clear the credential store.
- `tenkacloud whoami` — print the current ID token claims as JSON.
- `tenkacloud status` — show sign-in state (token TTL remaining).

### Required env vars (Phase 1)

| Variable                              | Example                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN` | `https://tenkacloud-dev.auth.ap-northeast-1.amazoncognito.com`         |
| `TENKACLOUD_COGNITO_CLI_CLIENT_ID`    | `123abc...` (UserPool Client ID for the CLI)                           |
| `TENKACLOUD_COGNITO_ISSUER`           | `https://cognito-idp.ap-northeast-1.amazonaws.com/<userPoolId>`        |

The Cognito UserPool Client must allow loopback redirect URIs
(`http://127.0.0.1:*/callback`) and the `code` flow with the standard
`openid profile email` scopes.

## Phase 2 — API operation subcommands (Issue #1305)

Every Phase 2 subcommand uses the Phase 1 credential store. If the access token
is within 5 minutes of expiry, the CLI calls Cognito `/oauth2/token` with the
`refresh_token` grant automatically; on failure it surfaces a 401 with
"Run `tenkacloud login` first".

The Bearer token is **never** logged or echoed to stdout / stderr.

### Output flags (any subcommand)

- `--json` — raw JSON (pipe into `jq`)
- `--csv` — comma-separated (open in Excel)
- default — pretty ASCII box table

### System Admin (Control Plane)

```
tenkacloud tenants list
tenkacloud tenants get <tenantId>
tenkacloud tenants create --name <n> --tier <BASIC|STANDARD|PREMIUM|PLATINUM> --admin-email <e>
tenkacloud tenants delete <tenantId>
```

### Tenant Admin (Application Plane)

```
tenkacloud events list [--status <RUNNING|ENDED|ARCHIVED>]
tenkacloud events get <eventId>
tenkacloud events create --name <n> --start <iso8601> --end <iso8601> --problemset <id>
tenkacloud events end <eventId>
tenkacloud events archive <eventId>
tenkacloud events report <eventId>     # prints Markdown summary
```

### Problem deploy

```
tenkacloud deploy <eventId> <teamId> <problemId>
tenkacloud deploy bulk <eventId>       # fan out all problems x all teams
tenkacloud deploy status <deploymentId>
tenkacloud deploy logs <deploymentId>
```

### Scoreboard

```
tenkacloud scoreboard <eventId>
tenkacloud score-events <eventId> [--team <t>] [--from <iso>] [--to <iso>]
```

### SAML SSO IdP (#1293 / #1294)

```
tenkacloud idp list
tenkacloud idp create --name <n> --metadata-url <url>
tenkacloud idp update <idpId> --metadata-url <url>
tenkacloud idp delete <idpId>
```

### Audit log (#1292)

```
tenkacloud audit query [--from <iso>] [--to <iso>] [--principal <p>] [--action <a>]
tenkacloud audit export --from <iso> --to <iso> --out <path.csv>
```

### Required env vars (Phase 2)

Plane separation in TenkaCloud means each scope hits a different API stack, so
the CLI requires one base URL per scope (no defaults — missing env fails loud).

| Variable                       | Used by                                |
| ------------------------------ | -------------------------------------- |
| `TENKACLOUD_API_BASE_CONTROL`  | `tenants` (Control Plane / SBT)        |
| `TENKACLOUD_API_BASE_TENANT`   | `events`, `idp`, `audit` (Tenant API)  |
| `TENKACLOUD_API_BASE_DEPLOY`   | `deploy` (ProblemDeployBackendStack)   |
| `TENKACLOUD_API_BASE_EVENT`    | `scoreboard`, `score-events`           |

### Error handling

| HTTP status | CLI message                                                           |
| ----------- | --------------------------------------------------------------------- |
| `401`       | 認証が必要です。 `tenkacloud login` を実行してください                  |
| `403`       | 権限がありません (= 要 role を確認してください)                         |
| `404`       | 対象が見つかりません: `<path>`                                          |
| `5xx`       | サーバーエラー (HTTP `<code>`)。 再試行してください                     |

There are no silent fallbacks; every error exits non-zero with a printed cause.

## Phase 3 — local self-paced mode (Issue #1975)

A free, single-player mode: run **only** the Participant Portal against a local
backend, with no AWS / Cognito / SBT / CloudFormation. The fixed local context is
`tenantId = eventId = teamId = participantId = "local"`.

```
tenkacloud local up [problemId] [--port N]   # start the local API + write portal runtime-config
tenkacloud local serve [--port N]            # foreground worker the `up` command spawns
tenkacloud local open [url]                   # open the portal (login with any key)
tenkacloud local status                       # is the local API running?
tenkacloud local evaluate <problemId> <flag>  # submit a flag from the terminal
tenkacloud local down                         # stop the local API
```

`local up` reads the problem catalog from `problems/` (override with
`TENKACLOUD_PROBLEMS_DIR`), spawns a detached Local Participant API (a `node:http`
server serving the `/portal/*` contract from the catalog), and writes a portal
`runtime-config.json` (`mode: "backend"`, `apiBaseUrl: http://127.0.0.1:<port>`).
Start the portal with `cd apps/participant-portal && bun run dev`, then sign in
with any team key. The portal allows a loopback-http backend (the bearer never
leaves the machine), so no HTTPS / certificate is needed.

Local scoring is for practice (anti-cheat is a non-goal here): the accepted flag
is the deterministic `TC{local-<problemId>}` and hints reveal their content
immediately. Delegating each problem's real runtime to Docker Compose and the
full per-kind scoring engine are tracked follow-ups.

### Local mode env vars

| Variable                          | Default                                              |
| --------------------------------- | --------------------------------------------------- |
| `TENKACLOUD_PROBLEMS_DIR`         | `<cwd>/problems`                                     |
| `TENKACLOUD_LOCAL_DIR`            | `~/.tenkacloud/local` (state file)                  |
| `TENKACLOUD_LOCAL_PORT`           | `3199`                                               |
| `TENKACLOUD_PORTAL_RUNTIME_CONFIG`| `apps/participant-portal/public/runtime-config.json`|
| `TENKACLOUD_PORTAL_URL`           | `http://localhost:5175` (for `local open`)          |

## Running locally

```
bun run apps/cli/bin/tenkacloud.ts login
bun run apps/cli/bin/tenkacloud.ts status
bun run apps/cli/bin/tenkacloud.ts tenants list --json
```

## Tests

```
bun run --filter @TenkaCloud/cli test
bun run --filter @TenkaCloud/cli typecheck
```

Tests cover PKCE primitives, the credential refresh flow, the auth fetch
wrapper, the output formatter, and each command module with a mocked `fetch`.
End-to-end OAuth (the browser dance) is exercised manually — Cognito UserPool
Client setup is environment-dependent.
