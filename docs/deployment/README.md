<!-- markdownlint-disable MD013 -->
# TenkaCloud deployment guide

This guide walks you through deploying **Lite mode** — the single-tenant runtime for
"one organizer running one event" — end to end. There are two supported paths:

| Path | Use it when | Where the deploy runs |
| --- | --- | --- |
| [A. Local terminal (`make deploy`)](#a-local-terminal-make-deploy) | You can install the repo toolchain on your machine | Your shell |
| [B. AWS Console pipeline](#b-aws-console-pipeline-no-local-install) | You do not want to install Bun / CDK locally | CloudFormation → CodePipeline → CodeBuild |

Both paths deploy the **same** two stacks into your AWS account and produce the same
result, so pick whichever fits your environment:

- `tenkacloud-lite` — Application Admin Console (organizer UI) + AppPlaneCore (`tenantId="local"`)
- `tenkacloud-lite-problem-deploy` — problem deploy backend + Participant Portal

A successful deploy emails a **Cognito invitation** (temporary password) to your
organizer address and prints the **Application Admin Console** and **Participant
Portal** URLs.

For full multi-tenant SaaS mode (pooled / silo tiers + SBT Control Plane), see
[SaaS mode](#saas-mode) at the end.

---

## Prerequisites (both paths)

- An **AWS account** and credentials that can run CloudFormation / CDK (create IAM
  roles, S3, Lambda, Cognito, DynamoDB, CodeBuild, EventBridge, Step Functions).
- A **region** — the examples use `ap-northeast-1`. Use the same region everywhere.
- An **organizer email** that can receive mail (it gets the Cognito invite and
  becomes the Application Admin Console's first user).
- Roughly **15 minutes** of wall-clock time for the first deploy (CDK creates the
  stacks from scratch).

Path A additionally needs a local toolchain (installed by `make install`). Path B
additionally needs a one-time **GitHub connection** in AWS.

---

## A. Local terminal (`make deploy`)

### A-1. Clone the repo (with the problem catalog submodule)

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
```

If you already cloned without `--recurse-submodules`, run
`git submodule update --init --recursive` so `problems/` is populated.

### A-2. Install the toolchain

```bash
make install
```

This installs every workspace's dependencies with Bun (lifecycle scripts disabled,
per the supply-chain policy) and bootstraps the Git hooks.

### A-3. Configure the environment

```bash
make env-init
```

`make env-init` creates `infrastructure/environments/development/.env` and prompts for
the Lite-mode values. Prefer manual setup? Copy the example and edit it:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# set AWS_ACCOUNT_ID, AWS_REGION, and TENANT_ADMIN_EMAIL
```

In Lite mode `TENANT_ADMIN_EMAIL` is the only required address — `SYSTEM_ADMIN_EMAIL`
is a SaaS-only field and is not needed here.

### A-4. Bootstrap CDK (first time only, per account/region)

```bash
make bootstrap
```

`cdk bootstrap` is idempotent; skip it on later deploys into the same account/region.

### A-5. Deploy

```bash
make deploy
```

`make deploy` runs three phases (it streams CDK output directly):

1. **Prepare source bundle** — packages `source.zip` and uploads it to a per-account S3 bucket (`tenkacloud-source-<account>-<region>`), created automatically on the first deploy. No bucket setup is needed, and the name is unique per account so a brand-new account works.
2. **Deploy 2 stacks** — `cdk deploy` of `tenkacloud-lite` + `tenkacloud-lite-problem-deploy` (~10 minutes the first time).
3. **Resolve URLs + create the Tenant Admin** — sends the Cognito invite email and prints the access URLs.

### A-6. Get the URLs and sign in

```bash
make lite-status        # CFn status of both stacks
make lite-console-url   # Application Admin Console URL
make lite-portal-url    # Participant Portal URL
```

Open the **Application Admin Console** URL and sign in with the email +
**temporary password** from the Cognito invitation; you will be asked to set a new
password on first sign-in.

### A-7. Tear down

```bash
make destroy
```

Removes both Lite stacks (RemovalPolicy=DESTROY tears down S3 / DynamoDB with them).

---

## B. AWS Console pipeline (no local install)

This path provisions a CloudFormation stack that builds a CodePipeline + CodeBuild
project; CodeBuild then runs `make deploy` for you inside AWS. You only use the AWS
Console.

### B-1. Create a GitHub connection (one time)

AWS Console → **Developer Tools** → **Connections** → **Create connection** →
**GitHub** → finish the OAuth flow → **copy the connection ARN**
(`arn:aws:codeconnections:<region>:<account>:connection/<id>`).

> CloudFormation cannot create the GitHub authorization for you, so this is a manual
> prerequisite.

### B-2. Download the pipeline template

Download
[`infrastructure/templates/lite-pipeline.yaml`](../../infrastructure/templates/lite-pipeline.yaml)
from this repo (the quick-create button needs the file hosted in S3, so uploading it
in the console is the reliable no-local path).

### B-3. Create the CloudFormation stack

1. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template) in your region.
2. Choose **Upload a template file**, upload `lite-pipeline.yaml`.
3. Stack name: `tenkacloud-lite-pipeline`.
4. Fill in the parameters:

   | Parameter | Required | Notes |
   | --- | --- | --- |
   | `TenantAdminEmail` | **Yes** | Organizer email — receives the Cognito invite |
   | `GitHubConnectionArn` | **Yes** | The ARN from step B-1 |
   | `Environment` | No | `development` (controls resource names, e.g. the pipeline `tenkacloud-lite-development`) |
   | `GitHubRepositoryId` | No | `susumutomita/TenkaCloud`, or your fork as `owner/repo` |
   | `SourceBranchName` | No | Branch to deploy; default `main` |
   | `EnableManualApproval` | No | Keep `true` to gate the deploy behind a one-click approval |
   | `DeployExternalId` | No | Only set when you are ready to deploy into competitor accounts |
   | `BunVersion` | No | `1.3.11` (matches the repo toolchain) |

5. Acknowledge the IAM capabilities and **create the stack**. The pipeline
   (`tenkacloud-lite-development`) is created in ~2-3 minutes and starts a run
   automatically.

### B-4. Approve the manual gate ⚠️ (don't skip this)

With `EnableManualApproval=true` (the default), the pipeline **pauses at an "Approve"
stage and will not deploy until you approve it**. This is the single most common
"nothing is happening" surprise.

- Console: **CodePipeline** → `tenkacloud-lite-development` → the **Approve** stage →
  **Review** → **Approve**.
- Or via CLI:

  ```bash
  aws codepipeline put-approval-result \
    --pipeline-name tenkacloud-lite-development \
    --stage-name Approve --action-name ManualApproval \
    --region ap-northeast-1 --status Approved \
    --result summary="approve lite deploy" \
    --token "$(aws codepipeline get-pipeline-state --name tenkacloud-lite-development \
      --region ap-northeast-1 \
      --query 'stageStates[?stageName==`Approve`].actionStates[0].latestExecution.token' \
      --output text)"
  ```

(Set `EnableManualApproval=false` if you want the pipeline to deploy without a gate.)

### B-5. Watch the build

After approval, the **Deploy** stage runs CodeBuild (`make deploy`, ~13 minutes the
first time). Watch it in **CodePipeline → Deploy → details**, or in the CodeBuild
project `tenkacloud-lite-development`. The build runs the same three phases as the
local path (prepare bundle → cdk deploy → URLs + Tenant Admin invite).

### B-6. Get the URLs

When the build succeeds, the tail of the build log prints:

```text
Access URLs:
  - Application Admin Console: https://<id>.cloudfront.net
  - Participant Portal:        https://<id>.lambda-url.<region>.on.aws/
```

and a **Cognito invitation email** is sent to `TenantAdminEmail`. Sign in to the
Application Admin Console with that email + temporary password.

### B-7. Re-run after a change

The pipeline does not auto-trigger on every push. To run it again:

- Console: **CodePipeline → Release change**, or
- CLI: `aws codepipeline start-pipeline-execution --name tenkacloud-lite-development --region ap-northeast-1`

Each run pauses at the **Approve** gate again (B-4) before deploying.

### B-8. Tear down

1. Delete the two app stacks in **CloudFormation**: `tenkacloud-lite` and
   `tenkacloud-lite-problem-deploy`.
2. Delete the pipeline stack `tenkacloud-lite-pipeline`.
3. The pipeline's artifact bucket (`tenkacloud-lite-development-pipeline-artifacts-<account>`)
   and the source bucket may need to be emptied before they delete.

---

## After deploy (both paths)

1. Sign in to the **Application Admin Console** (Cognito temp password → set a new one).
2. Create an event, register teams, and select problems from the catalog.
3. Start a problem deploy and watch progress.
4. Share the **Participant Portal** URL with teams (each team's login key is issued
   when you create the event).

See the [runbooks](../runbooks/README.md) for event-day operations (pre-event
checklist, live monitoring, teardown).

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Pipeline "isn't doing anything" | It is waiting at the **Approve** gate — approve it (B-4). |
| `Your session has expired` (local) | Refresh your AWS credentials (`aws sso login` / your login flow). |
| `cdk bootstrap` / "bootstrap" errors | Run `make bootstrap` once for the account/region. |
| Region mismatch | `AWS_REGION` in `.env` must match the region you are deploying to. |
| Submodule / `problems/` empty | `git submodule update --init --recursive`. |

---

## SaaS mode

For full multi-tenant operation — pooled tiers (BASIC / STANDARD / PREMIUM), the
silo tier (PLATINUM), SystemAdmin invitations, and the SBT Control Plane — use SaaS
mode instead:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# set SYSTEM_ADMIN_EMAIL, AWS_ACCOUNT_ID, and AWS_REGION

make deploy-saas     # 3-phase deploy (scripts/install.sh)
make destroy-saas    # idempotent teardown
```

SaaS mode runs three phases (Control Plane + bootstrap + pooled tenant + pipeline →
admin console hosting → callback/CORS update). See
[`../../CLAUDE.md`](../../CLAUDE.md) ("Deploy flow") for the phase details.
