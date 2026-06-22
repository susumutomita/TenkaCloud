# API Security Deploy Challenge (`cloudflare-api-security-001`)

A free, no-AWS-account security challenge (Issue #1973). You publish a profile API
as a Cloudflare Worker, then harden it stage by stage until TenkaCloud's external
evaluator passes it. The grading conditions, hidden test inputs, and clear-code
signing key live **only** on the TenkaCloud side — they are not in this repository.

## What you do

1. Deploy this starter Worker (it is intentionally vulnerable).
2. Submit your `https://{subdomain}.workers.dev` URL to the evaluator.
3. Read the safe failure summaries and fix the next vulnerability.
4. Re-deploy and re-evaluate. Each passed stage returns a one-time clear code.

The participant app may also run on a local container or another cloud — the
evaluator only needs a reachable endpoint. The public free mode targets Cloudflare
Temporary Accounts because they need no signup and self-delete after 60 minutes.

## Deploy

```bash
bunx wrangler deploy --temporary
# -> https://{subdomain}.workers.dev
```

## API contract (public)

Two fixed fixture users exist. These tokens are part of the contract so the
evaluator can test cross-user access:

| User  | id        | Bearer token |
| ----- | --------- | ------------ |
| Alice | `u_alice` | `tok_alice`  |
| Bob   | `u_bob`   | `tok_bob`    |

| Method + path       | Expected behavior                                                        |
| ------------------- | ------------------------------------------------------------------------ |
| `GET /healthz`      | `200` with JSON containing `ok`                                           |
| `GET /profiles/:id` | `401` no/invalid token, `403` other user, `200` `{id,name,email}` if self |
| `PATCH /profiles/:id` | Validate body; `400` invalid, `401`/`403` auth, `200` updated if self   |
| unknown path        | `404` (never leak stack traces, internal errors, or secret values)       |

## Stages

| Stage | You implement                                                  |
| ----- | -------------------------------------------------------------- |
| 0     | Deploy: `/healthz` and own-profile read reachable over HTTPS   |
| 1     | Input validation: reject bad JSON, wrong type, empty, too long |
| 2     | Authorization: block reading/updating another user (IDOR)      |
| 3     | Information disclosure: no stack traces, internals, or secrets  |
| 4     | Final: keep normal behavior while all defenses hold (regression) |

Exact test inputs vary per run, so hardcoding a fixed response will not pass.

## Evaluate

Point the evaluator at your endpoint. Locally (no AWS, no Cloudflare account —
runs the same engine the cloud uses):

```bash
# 1. start the evaluator (from the repo root)
ENDPOINT_EVAL_SIGNING_SECRET=dev-secret bun run packages/endpoint-eval/src/server.ts

# 2. create a run
curl -s -X POST localhost:8787/runs \
  -H 'content-type: application/json' \
  -d '{"challengeId":"cloudflare-api-security-001"}'

# 3. evaluate a stage against your deployed (or local) endpoint
curl -s -X POST localhost:8787/runs/<runId>/evaluations \
  -H 'content-type: application/json' \
  -d '{"stage":"0-deploy","endpoint":"https://<subdomain>.workers.dev"}'
```

A passed stage returns a signed, short-lived `clearCode`. Running the API locally
without going through the evaluator cannot produce a valid clear code.
