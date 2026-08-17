# Running costs

This is the full detail behind the [README's Running costs summary](../README.md#running-costs): what each profile costs, the opt-in walkthrough for the zero-cost profile, the migration path for an existing stack, measured numbers, and what has and has not been live-verified.

> **Before you opt in — not yet live-verified.** Every claim on this page is implemented and covered by CDK-synth and repository-seam unit tests, but nobody has run `make deploy` with `CONTROL_DATA_BACKEND=turso` against a fresh AWS account and a real Turso database and read the resulting AWS bill yet. See [Live-verification status](#live-verification-status) at the bottom of this page before relying on the zero-cost profile for a real event. **Start here:** run `make turso-live ENV=development`. The wizard walks through Turso and AWS setup, performs the read-only preflight, and only deploys after an exact `deploy` confirmation. It never automates destruction.

## The two profiles

TenkaCloud runs in one of two profiles, selected by the `CDK_PARAM_CONTROL_DATA_BACKEND` env var (unset = default).

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default, unset or `dynamodb`) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1), 8 tables + 8 GSIs | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, `turso`) | Individuals, trials, personal events | Turso (libSQL) — 0 DynamoDB tables / 0 GSIs in the Lite synth | Lambda `CreateStack` (default) |

### Cost budget guardrails are opt-in

The AWS Budget and the Free Tier alarms that hang off it are **off in every environment unless
you ask for them**. Set `MONTHLY_COST_LIMIT_USD` to a positive value to get the budget, its SNS
topic and the alarms; leave it unset or `0` and the synthesized template contains none of them.

Off is the default because of the SNS confirmation email, not because the guardrail is unwanted.
Every deploy that recreated the stack produced a new topic, so AWS re-sent a subscription
confirmation — and a subscription nobody confirms carries `PendingConfirmation` instead of a real
`SubscriptionArn`, which means **neither the API nor the console can delete it**. It only expires
on AWS's own schedule. Not creating it is the only way to not accumulate it.

The system administrator address is never subscribed on your behalf. `systemAdminEmail` says who
runs the platform, which is a different question from who wants budget mail; list recipients
explicitly in the environment's `config.json` under `budgetAlarmEmails`. Watching the numbers in
the Billing console is a perfectly good arrangement — set the limit and leave the list empty.

Lite mode (`make deploy`) is already the lean path. The problem-deploy backend runs on **Lambda `CreateStack`/`UpdateStack` by default** (no CodeBuild project), and the KMS customer-managed key was removed in favor of the AWS-managed key. What is left standing on the default profile is DynamoDB: eight tables plus eight GSIs pinned at PROVISIONED 1/1, which bill even while idle. The eight tables are **Events, Teams, Deployments, ProblemEndpoints, CompetitorAccounts, Disruptions, AdminAuditLog, and SamlIdps**.

Opting into `CONTROL_DATA_BACKEND=turso` removes all eight of those tables — CDK does not synthesize any of them, which is what actually removes the standing cost, not just the read/write path. The SAML IdP CRUD API (`/tenant/idp*`) keeps working on the Turso profile: the Lambda is decoupled from table presence and resolves the repository through the same seam as the other seven tables, so opting into `turso` yields a Lite synth with **zero `AWS::DynamoDB::Table` resources**.

## Opt in to the zero-cost profile

The steps below are for a **fresh** stack. See [Migrating an existing stack](#migrating-an-existing-stack) below if you are already running on the `dynamodb` profile.

1. **Create a Turso database** ([Turso CLI](https://docs.turso.tech/cli/introduction)):

   ```bash
   turso db create tenkacloud-lite
   turso db show tenkacloud-lite --http-url
   turso db tokens create tenkacloud-lite
   ```

   `db tokens create` issues a token that never expires by default. If you pass `--expiration Nd`, the token stops working after N days and every Turso Lambda starts answering `401`; reissue it with `make turso-token-rotate ENV=development`, which reissues into SSM without printing the token.

   `db show --http-url` prints something like `https://tenkacloud-lite-<organization>.turso.io`. The Lambda uses the HTTP-only libSQL client, so the live runbook standardizes on the provider's HTTP URL and removes URL protocol conversion from the experiment. Keep the token from `db tokens create` for the next step without pasting it into a command line.

2. **Store the token in SSM as a `SecureString`** — never write it into `.env`:

   ```bash
   read -rs TURSO_TOKEN
   printf '%s' "$TURSO_TOKEN" | aws ssm put-parameter \
     --name /TenkaCloud/development/turso/auth-token \
     --type SecureString \
     --value file:///dev/stdin \
     --region ap-northeast-1
   unset TURSO_TOKEN
   ```

3. **Add three lines to `infrastructure/environments/<env>/.env`** (copy from the matching `.env.example` first if you have not already):

   ```bash
   CDK_PARAM_CONTROL_DATA_BACKEND=turso
   CDK_PARAM_TURSO_DATABASE_URL=https://tenkacloud-lite-<organization>.turso.io
   CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token
   ```

4. **`make deploy`.** CDK skips synthesizing all eight DynamoDB tables listed above; the first Lambda cold start creates the SQL schema on the Turso database for you (no manual migration step). `env-check-lite` (the gate `make deploy` runs first) validates that both `CDK_PARAM_TURSO_DATABASE_URL` and `CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME` are set whenever `CDK_PARAM_CONTROL_DATA_BACKEND` is `turso`, so a missing value fails immediately instead of after a full SPA build or, worse, at the deploy Lambda's first cold start.

## First live E2E verification runbook

This is the source of truth for the first live verification. It is deliberately more explicit than the four-step opt-in path: a successful `make deploy` alone does not prove that all eight repositories, cross-account problem deployment, participant scoring, and SAML IdP CRUD work against a real Turso database.

### 0. Use a fresh environment

Use a fresh Lite stack with no control data to migrate. Do not point this runbook at an existing `dynamodb` deployment: a direct switch removes the DynamoDB resources, deleting the tables under the default policy or orphaning them only if the deployment explicitly enabled retention. Existing deployments must use [Migrating an existing stack](#migrating-an-existing-stack).

Choose the environment once and pass it to every command. The examples use `development`:

```bash
make turso-live ENV=development
```

For `staging` or another environment, the wizard uses the matching `.env` path, SSM path, and suffixed CloudFormation stack names. It creates or reuses the Turso database and SSM `SecureString`, merges `samlSso: true` without discarding other feature flags, runs preflight, asks for the exact word `deploy`, and verifies both deployed stacks. The token is captured in memory and sent to the AWS CLI over stdin; it is never printed, placed in process argv, or written to `.env`.

The remaining numbered sections are the manual fallback and the post-deploy browser checklist. `ENV=development tenkacloud turso-live guide` prints the same fallback without requiring the Turso CLI.

### 1. Confirm identities and install the CLIs

You need Bun dependencies installed, an authenticated AWS CLI, and an authenticated Turso CLI. Do not proceed until `aws sts get-caller-identity` shows the account named by `AWS_ACCOUNT_ID` in the selected `.env`.

```bash
bun install --frozen-lockfile --ignore-scripts
aws sts get-caller-identity
turso auth login
```

On macOS and Linux (including Codespaces), the recommended `tenkacloud turso-live` wizard installs the pinned official Turso Cloud CLI release under `~/.turso` after verifying its published SHA-256 checksum. It deliberately avoids Homebrew and external tap dependencies. The wizard invokes the installed path directly and does not edit your shell profile; for manual commands, either use `~/.turso/turso` or add `~/.turso` to `PATH` yourself. See the [Turso CLI introduction](https://docs.turso.tech/cli/introduction) for upstream CLI reference.

CodeBuild is non-interactive: pre-install the same pinned CLI in the build image and provide `TURSO_API_TOKEN` from the build environment's secret store. The live deploy wizard remains TTY-only and still requires the exact `deploy` confirmation. This runbook never asks you to put either an AWS credential or a Turso token in the repository.

### 2. Create the Turso database and secret

Create a database and copy its HTTP URL. Generate a full-access database token because schema initialization and every CRUD flow write rows.

```bash
turso db create tenkacloud-lite
turso db show tenkacloud-lite --http-url
turso db tokens create tenkacloud-lite
```

`db tokens create` defaults to a token with no expiry. A token created with `--expiration Nd` has to be reissued every N days — use `make turso-token-rotate ENV=development` for that, so the token never reaches the terminal.

Put the token in SSM `SecureString` in the same AWS region as the Lite deployment. Reading it into a shell variable keeps the token itself out of shell history; clear the variable immediately afterward.

```bash
read -rs TURSO_TOKEN
printf '%s' "$TURSO_TOKEN" | aws ssm put-parameter \
  --name /TenkaCloud/development/turso/auth-token \
  --type SecureString \
  --value file:///dev/stdin \
  --region ap-northeast-1
unset TURSO_TOKEN
```

Do not paste the token into `.env`, an Issue comment, a screenshot, or the live-evidence record.

### 3. Configure the selected `.env`

Create `infrastructure/environments/development/.env` with `make env-init` if it does not exist, then set the following public wiring values:

```bash
CDK_PARAM_CONTROL_DATA_BACKEND=turso
CDK_PARAM_TURSO_DATABASE_URL=https://tenkacloud-lite-<organization>.turso.io
CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token
CDK_PARAM_FEATURES={"samlSso":true}
```

The `samlSso` override is part of this verification, not an unrelated product setting. The Identity providers page is experimental and hidden by default, so omitting it makes the SAML acceptance check impossible even though the backend Lambda exists.

Also verify that `AWS_ACCOUNT_ID`, `AWS_REGION`, and `TENANT_ADMIN_EMAIL` contain real values. Never commit `.env`.

### 4. Run the read-only preflight

```bash
ENV=development tenkacloud turso-live preflight
```

The preflight fails unless the exact pure backend (`turso`) and the SAML verification flag are selected. It checks the active AWS account, region, and SSM parameter type. The SSM call uses `describe-parameters`, not `get-parameter`; it proves that a `SecureString` exists without requesting the token value.

Stop here on any red line. The output names the value or identity to fix.

### 5. Deploy explicitly

This is the first state-changing step. It bootstraps CDK, uploads the source bundle, and creates or updates AWS resources, so review the selected account and region again before running it.

```bash
ENV=development tenkacloud turso-live deploy
```

Save the full terminal output. A green command satisfies only the deploy portion of the acceptance criteria; continue through every step below.

### 6. Prove the deployed stacks contain zero DynamoDB tables

```bash
ENV=development tenkacloud turso-live verify-cloudformation
```

This read-only target resolves the same stack names as the deploy CLI, checks both stack states, and counts deployed `AWS::DynamoDB::Table` resources with `aws cloudformation list-stack-resources`. For `development`, the targets are `tenkacloud-lite` and `tenkacloud-lite-problem-deploy`. The result must end with both of these lines:

```text
✓ DynamoDB tables: 0
✓ CloudFormation acceptance passed
```

Do not substitute a local synth result here. The Issue acceptance criterion is the deployed CloudFormation state.

### 7. Exercise the live data path in order

Open the Application Admin Console URL printed by `make deploy` and sign in with the Cognito invitation sent to `TENANT_ADMIN_EMAIL`.

1. Open **Events**. The first real request cold-starts the Lambda and runs `initializeControlDataSchema`; record any error before retrying.
2. Open **Competitor Accounts**, choose **Add account**, and save the one-time ExternalId plus Launch Stack URL.
3. In the disposable competitor AWS account, create the bootstrap stack from that link. Return to TenkaCloud and choose **Verify**. The detailed manual alternative is in [`infrastructure/templates/README.md`](../infrastructure/templates/README.md).
4. Create one Event with one team and select catalog problems `hello-world` plus `hello-world-battle`. The first is the minimal answer-submission path; the second currently declares overridable endpoints and the bounded `frontend-down` disruption. Choose **Deploy now** and wait for both deployments to reach a successful terminal state. If either ID is absent in a future catalog, select the documented replacement with the same two contracts rather than skipping the check.
5. Copy the team login key from the deployment hand-off and open the Participant Portal URL. Sign in with that key.
6. Follow that problem's catalog `README`/`OPERATOR.md`, submit its expected answer, and wait for scoring. Confirm the Participant Portal score and the Application Admin Console scoreboard agree.
7. For the Battle, register an endpoint override, update it, and clear it again. Confirm each server response is reflected in the portal. This explicitly exercises ProblemEndpoints CRUD instead of merely reading an empty endpoint list.
8. In the Event's **Disruptions** tab, fire one declared manual disruption at the test team and confirm it appears in the fire history. Use the Battle's `OPERATOR.md` to reverse any physical effect afterward.
9. Open **Audit log** and confirm the earlier `create_competitor_account` action is present. This proves the AdminAuditLog write and tenant-scoped read paths, rather than inferring them from the account appearing in a different repository.
10. Open **Identity providers**. With a disposable real SAML IdP, complete create → list → edit → delete. The form prints the exact ACS URL and SP identifier; do not use fabricated metadata that the Cognito API would reject.

The mapping from each SQL repository to observable evidence is explicit:

| Repository | Live evidence |
| --- | --- |
| Events | Event create and subsequent read |
| Teams | The created team and participant login-key lookup |
| Deployments | Challenge/Battle deployment terminal state and scoring update |
| ProblemEndpoints | Endpoint override create/update/delete |
| CompetitorAccounts | Account add and live AssumeRole verification |
| Disruptions | Manual fire and history read |
| AdminAuditLog | `create_competitor_account` visible in Audit log |
| SamlIdps | IdP create/list/edit/delete |

Afterward, inspect CloudWatch for the involved Lambdas and record whether any schema, libSQL HTTP, SSM, or SQL error occurred. The full event-day operational checks remain in [`docs/operations/event-runbook.md`](./operations/event-runbook.md).

### 8. Capture evidence and check billing later

Copy the template below into the Issue or a PR description while the run is fresh. Redact account IDs if required by your disclosure policy, and always redact the SSM token and team login key.

```text
Live E2E date/time (UTC):
Git commit:
AWS account (redacted if needed) / region:
Turso database region/group:
make turso-live-preflight: PASS/FAIL
make deploy: PASS/FAIL (duration):
tenkacloud-lite status / DDB count:
tenkacloud-lite-problem-deploy status / DDB count:
Event create:
Competitor Account add + Verify:
Challenge + Battle deploy:
Participant login:
Scoring result:
ProblemEndpoints create/update/delete:
Disruption fire/history/reversal:
AdminAuditLog write/read:
SAML IdP create/list/edit/delete:
CloudWatch errors:
Turso usage immediately after run:
AWS Cost Explorer date checked / DynamoDB usage and cost:
Unexpected behavior and follow-up Issue:
```

Cost Explorer data can lag behind the deployment. Record the functional run immediately, then add a dated follow-up after AWS usage and cost data has settled. Credits showing an invoice total of `$0` are not proof that DynamoDB usage was zero; the CloudFormation resource count and the DynamoDB service usage line are separate evidence.

### 9. Tear down deliberately

After saving evidence, delete the problem stack in the competitor account, remove the competitor bootstrap stack, and then run `make destroy-all ENV=development` if the entire Lite environment is disposable. A normal `make destroy` also deletes DynamoDB tables under the default policy; tables survive only when the deployment previously set `CDK_PARAM_RETAIN_DATA_TABLES=true`. Destruction is intentionally not part of any `turso-live-*` helper: each deletion must be reviewed by the operator who owns the accounts.

## Migrating an existing stack

Moving an *existing* `dynamodb`-backed stack to `turso` is a separate, riskier path than a fresh deploy. The cutover removes the Events/Teams/Deployments/ProblemEndpoints/CompetitorAccounts/Disruptions/AdminAuditLog/SamlIdps resources from CloudFormation. With the default `CDK_PARAM_RETAIN_DATA_TABLES=false`, CloudFormation deletes those tables and their data. If the DynamoDB deployment was last updated with `CDK_PARAM_RETAIN_DATA_TABLES=true`, the cutover instead orphans the tables and they continue billing.

Recommended sequence, also documented in the `CDK_PARAM_CONTROL_DATA_BACKEND` comment block in [`infrastructure/environments/development/.env.example`](../infrastructure/environments/development/.env.example):

1. Export the data you need from the DynamoDB tables (scores, event definitions) before switching — the two backends never sync (#2677 removed the former `turso-mirror` dual-write bridge; the backend is a hard two-way choice now).
2. If you need the DynamoDB copy to survive the cutover, first redeploy the still-`dynamodb` stack with `CDK_PARAM_RETAIN_DATA_TABLES=true` and verify that update completed. Skip this step only when the export is sufficient and table deletion is intentional.
3. Redeploy with `CDK_PARAM_CONTROL_DATA_BACKEND=turso` — this is the point where CDK stops synthesizing the eight DynamoDB tables. The stack starts from an empty SQL database; re-create events/teams there.
4. If step 2 retained the tables, manually delete those orphaned tables (and their GSIs) with `aws dynamodb delete-table` after confirming you no longer need the DynamoDB copy.

Rolling back `turso` → `dynamodb` loses any write that only ever reached the SQL backend (pure SQL never writes to DynamoDB) — do this only with fresh/empty tables, not as a way to "undo" a cutover with live data. In practice: pick the backend per environment BEFORE the first real event; treat a mid-life cutover as a data migration project, not a flag flip.

## Measured cost (single AWS account, 2026-06, AWS-native/`dynamodb` profile)

| Source | Monthly | Status |
| --- | --- | --- |
| DynamoDB (provisioned tables) | ~$7.06 | Standing cost on the default `dynamodb` profile — opt into `CONTROL_DATA_BACKEND=turso` above to remove all 8 tables (zero `AWS::DynamoDB::Table` resources in the Lite synth) |
| CodeBuild (problem deploy) | part of ~$2.55 | **Resolved** — the Lambda deploy path is the default (#2353); no CodeBuild project in Lite mode |
| CodeBuild (SaaS tenant provisioning) | part of ~$2.55 | SaaS-mode only; not present in Lite mode |
| KMS customer-managed key | $0 | **Resolved** — AWS-managed key via a CDK Aspect |
| Explicitly retained tables after `destroy` | cumulative | Default `make destroy` deletes tables. A deployment with `CDK_PARAM_RETAIN_DATA_TABLES=true` preserves and reports them; `make destroy-all` removes only the exact tables owned by the two Lite stacks (#2765) |

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
