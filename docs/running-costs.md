# Running costs

This is the full detail behind the [README's Running costs summary](../README.md#running-costs): what each profile costs, the opt-in walkthrough for the zero-cost profile, the migration path for an existing stack, measured numbers, and what has and has not been live-verified.

## The two profiles

TenkaCloud runs in one of two profiles, selected by the `CDK_PARAM_CONTROL_DATA_BACKEND` env var (unset = default).

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default, unset or `dynamodb`) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1), 8 tables + 8 GSIs | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, `turso`) | Individuals, trials, personal events | Turso (libSQL) — 0 DynamoDB tables / 0 GSIs in the Lite synth | Lambda `CreateStack` (default) |

Lite mode (`make deploy`) is already the lean path. The problem-deploy backend runs on **Lambda `CreateStack`/`UpdateStack` by default** (no CodeBuild project), and the KMS customer-managed key was removed in favor of the AWS-managed key. What is left standing on the default profile is DynamoDB: eight tables plus eight GSIs pinned at PROVISIONED 1/1, which bill even while idle. The eight tables are **Events, Teams, Deployments, ProblemEndpoints, CompetitorAccounts, Disruptions, AdminAuditLog, and SamlIdps**.

Opting into `CONTROL_DATA_BACKEND=turso` removes all eight of those tables — CDK does not synthesize any of them, which is what actually removes the standing cost, not just the read/write path. The SAML IdP CRUD API (`/tenant/idp*`) keeps working on the Turso profile: the Lambda is decoupled from table presence and resolves the repository through the same seam as the other seven tables, so opting into `turso` yields a Lite synth with **zero `AWS::DynamoDB::Table` resources**.

## Opt in to the zero-cost profile

The steps below are for a **fresh** stack. See [Migrating an existing stack](#migrating-an-existing-stack) below if you are already running on the `dynamodb` profile.

1. **Create a Turso database** ([Turso CLI](https://docs.turso.tech/cli/introduction)):

   ```bash
   turso db create tenkacloud-lite
   turso db show tenkacloud-lite --url
   turso db tokens create tenkacloud-lite
   ```

   `db show --url` prints something like `libsql://tenkacloud-lite-<organization>.turso.io`; keep the token from `db tokens create` for the next step.

2. **Store the token in SSM as a `SecureString`** — never write it into `.env`:

   ```bash
   aws ssm put-parameter \
     --name /TenkaCloud/development/turso/auth-token \
     --type SecureString \
     --value "<token from step 1>"
   ```

3. **Add three lines to `infrastructure/environments/<env>/.env`** (copy from the matching `.env.example` first if you have not already):

   ```bash
   CDK_PARAM_CONTROL_DATA_BACKEND=turso
   CDK_PARAM_TURSO_DATABASE_URL=libsql://tenkacloud-lite-<organization>.turso.io
   CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token
   ```

4. **`make deploy`.** CDK skips synthesizing all eight DynamoDB tables listed above; the first Lambda cold start creates the SQL schema on the Turso database for you (no manual migration step).

## Migrating an existing stack

Moving an *existing* `dynamodb`-backed stack to `turso` is a separate, riskier path than a fresh deploy: the Events/Teams/Deployments/ProblemEndpoints/CompetitorAccounts/Disruptions/AdminAuditLog/SamlIdps DynamoDB tables all use `RemovalPolicy.RETAIN`, so cutting over directly orphans them (still billing) instead of deleting them.

Recommended sequence, also documented in the `CDK_PARAM_CONTROL_DATA_BACKEND` comment block in [`infrastructure/environments/development/.env.example`](../infrastructure/environments/development/.env.example):

1. Deploy with `turso-mirror` (or `sql-mirror`) first — this keeps DynamoDB canonical (every table still exists) while mirroring writes into SQL, so you can validate a cutover before switching to the pure value.
2. Verify the SQL replica is complete and correct.
3. Redeploy with `turso` (or `sql`, the pure value) once satisfied — this is the point where CDK stops synthesizing the eight DynamoDB tables.
4. Manually delete the now-orphaned tables (and their GSIs) with `aws dynamodb delete-table` after confirming you no longer need the DynamoDB copy.

Rolling back `turso`/`sql` → `dynamodb` loses any write that only ever reached the SQL backend (pure SQL never writes to DynamoDB) — do this only with fresh/empty tables, not as a way to "undo" a cutover with live data.

## Measured cost (single AWS account, 2026-06, AWS-native/`dynamodb` profile)

| Source | Monthly | Status |
| --- | --- | --- |
| DynamoDB (provisioned tables) | ~$7.06 | Standing cost on the default `dynamodb` profile — opt into `CONTROL_DATA_BACKEND=turso` above to remove all 8 tables (zero `AWS::DynamoDB::Table` resources in the Lite synth) |
| CodeBuild (problem deploy) | part of ~$2.55 | **Resolved** — the Lambda deploy path is the default (#2353); no CodeBuild project in Lite mode |
| CodeBuild (SaaS tenant provisioning) | part of ~$2.55 | SaaS-mode only; not present in Lite mode |
| KMS customer-managed key | $0 | **Resolved** — AWS-managed key via a CDK Aspect |
| Retained tables after `destroy` | cumulative | **Resolved** — `make destroy` now warns and prints delete commands (#2445) |

> **Free Tier note.** New-style AWS Free Tier accounts (2025-07 onward) are credit-based: there is **no** always-free 25 RCU/WCU DynamoDB allowance. Credits can make the visible bill read $0, but Usage still accrues from the first hour and becomes a real charge once the credits run out.

## Turso free-plan headroom

[`quota-model.ts`](../infrastructure/lib/problem-deploy/control-data/quota-model.ts) models the event-day SQL row traffic against Turso's free-plan monthly quota:

| Turso free-plan quota (as modeled in `quota-model.ts`) | Monthly limit |
| --- | --- |
| Row reads | 500,000,000 |
| Row writes | 10,000,000 |

The model counts one leaderboard-snapshot row read per participant per poll, one summary row write per scored change, and one snapshot row write per refresh interval. Its test fixture ([`quota-model.test.ts`](../infrastructure/test/problem-deploy/control-data/quota-model.test.ts)) — 300 participants, a 30-second leaderboard poll, a 24-hour event, 25,000 summary writes, a 30-second snapshot refresh — comes out to 864,000 row reads and 27,880 row writes: about 0.17 percent of the read quota and 0.28 percent of the write quota. That is a **model of an event-day access pattern**, not a bill from a live database — it shows that a single mid-size event has wide headroom under the free plan, nothing more.

## Live-verification status

**Not yet live-verified.** "CDK does not synthesize these 8 tables" (zero `AWS::DynamoDB::Table` resources in the Lite synth) is checked by `Template.fromStack` synth assertions and by repository-seam unit tests — solid evidence the code path exists, but nobody has run `make deploy` with `CONTROL_DATA_BACKEND=turso` against a fresh AWS account and a real Turso database and read the resulting AWS bill yet. The SAML IdP CRUD API is exercised against the SQL repository by unit tests only, not by a live Turso database either. Treat the "near-$0" claim as implemented-and-tested, not as a measured production result.
