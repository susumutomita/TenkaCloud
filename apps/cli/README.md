# @TenkaCloud/cli (Phase 1 scaffold)

TenkaCloud CLI for sign-in via Cognito OAuth (Authorization Code + PKCE + loopback).

## Phase 1 commands

- `tenkacloud login` — open Cognito Hosted UI in the browser, capture the
  authorization code via a local loopback HTTP server (`127.0.0.1:<random>`),
  exchange for ID/access/refresh tokens, persist to
  `~/.config/tenkacloud/credentials` (mode `0600`).
- `tenkacloud logout` — clear the credential store.
- `tenkacloud whoami` — print the current ID token claims as JSON.
- `tenkacloud status` — show sign-in state (token TTL remaining).

## Required environment

`tenkacloud login` reads these env vars:

| Variable | Example |
| --- | --- |
| `TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN` | `https://tenkacloud-dev.auth.ap-northeast-1.amazoncognito.com` |
| `TENKACLOUD_COGNITO_CLI_CLIENT_ID` | `123abc...` (UserPool Client ID for the CLI) |
| `TENKACLOUD_COGNITO_ISSUER` | `https://cognito-idp.ap-northeast-1.amazonaws.com/<userPoolId>` |

The Cognito UserPool Client must allow loopback redirect URIs
(`http://127.0.0.1:*/callback`) and the `code` flow with the standard
`openid profile email` scopes.

## What's not in Phase 1

- `tenants list`, `events list`, etc — Phase 2 will add API subcommands.
- OS-native credential storage (macOS Keychain / Linux Secret Service /
  Windows Credential Manager) — Phase 2.
- Automatic refresh token rotation — Phase 2.

These are tracked as follow-up work in the original feature spec.

## Running locally

```
bun run apps/cli/bin/tenkacloud.ts login
bun run apps/cli/bin/tenkacloud.ts status
```

## Tests

```
bun run --filter @TenkaCloud/cli test
bun run --filter @TenkaCloud/cli typecheck
```

Tests cover PKCE primitives. End-to-end OAuth flow is exercised manually in
this phase (= Cognito UserPool Client setup is environment-dependent).
