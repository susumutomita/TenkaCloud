# 5-minute clone-to-running-event quickstart

> 日本語版: [quickstart-5min.ja.md](./quickstart-5min.ja.md)

**One-liner**: TenkaCloud is an open-source cloud-competition platform on real AWS. Clone the repo, run `make deploy`, and inside ten minutes you have an admin console, a deployed problem, and a participant portal where one team can solve a real AWS task and see their score change.

This walkthrough takes about **5 minutes of talking time** plus an out-of-band deploy that runs in the background. Practice it once, and you can rerun it at a meetup, a sales call, or a recording セッション without surprises。

## Prerequisites

| Item            | Why                                                         |
| --------------- | ----------------------------------------------------------- |
| AWS account     | Lite mode deploys into one account, Free-Tier friendly.     |
| `bun` 1.3.11+   | The monorepo uses Bun workspaces, no `npm` / `npx`.         |
| `git` 2.40+     | Submodules deliver the problem catalog under `problems/`.   |
| AWS CLI v2      | Used for `aws sso login` / credentials in front of the CDK. |

You do **not** need Cognito, SBT, or any pre-configured tenant for this walkthrough. Lite mode wires `tenantId="local"` automatically.

## Step 1 — Clone and install (≈ 30 s talking time)

**Action.**

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
```

**What just happened.** Bun installed the workspaces (`infrastructure` plus three SPAs), the `problems/` submodule was checked out, and lifecycle scripts were skipped by default (see the supply-chain notes in `CLAUDE.md`).

**Fallback.** If submodules show as empty, run `git submodule update --init --recursive problems`. Never use `--no-verify` on any commit step.

## Step 2 — Deploy Lite mode (≈ 30 s talking time, ~10 min background)

**Action.** In a separate terminal, kick off:

```bash
make deploy
```

Keep talking while it runs. Lite mode (introduced in #955) stands up exactly two stacks: `AppPlaneCore` (`tenantId="local"`) and `ProblemDeployBackend` (the participant portal).

**What just happened.** CDK synth + deploy produced:

- A single-tenant Cognito UserPool for the organizer
- A DynamoDB table forced to 1 RCU / 1 WCU by the `DynamoDbLowCapacity` Aspect (Free-Tier safe)
- The Application Admin Console hosted on S3 + CloudFront
- The Participant Portal hosted on S3 + CloudFront
- An EventBridge bus that all four planes share

**Fallback.** Pre-deploy before the talk. If the deploy fails mid-talk, switch tabs to the pre-deployed Console URL.

## Step 3 — Open the Application Admin Console and create event "Demo 5min" (≈ 1 min)

**Action.** Open the CloudFront URL printed by `make deploy` ending in `application-admin-console`. Log in with the organizer Cognito user, then:

1. Click **New event**
2. Name: `Demo 5min`
3. Save

**What just happened.** The Application Plane wrote an `Event` row keyed by `(tenantId="local", eventId)`. No CFn stack runs yet — events are pure metadata.

**Fallback.** If the console is blank, hard-refresh once. `runtime-config.json` is fetched at boot and a stale browser cache will hide it.

## Step 4 — Add the `hello-world` problem (≈ 1 min)

**Action.** Inside the new event:

1. Click **Add problem**
2. Pick `hello-world` (Challenge, Difficulty 1 / 5, estimated 1 minute)
3. Confirm

**What just happened.** The catalog (`problems/index.json`) was loaded from the submodule. `hello-world` is the minimal `flag` scoring problem: it deploys one `AWS::SSM::Parameter` plus a `ParticipantViewerRole` that lets the team read only their own SSM prefix (see `problems/challenges/hello-world/README.md`). No EC2, no VPC, no public endpoint, no real spend.

**Fallback.** If the catalog list is empty, the submodule did not check out. Re-run `git submodule update --init --recursive problems` and refresh.

## Step 5 — Bulk-deploy to the team (≈ 1 min talking time, ~2 min background)

**Action.** Pick the demo team (or create a placeholder team), then click **Deploy to all teams**.

**What just happened.** The Application Plane emitted a `DeployRequested` event onto the EventBridge bus. The `ProblemDeployBackend` Worker Lambda picked it up, AssumeRoled into the competitor account using the tenant's `ExternalId` (always required — see `CLAUDE.md`), and ran CFn `CreateStack` with `problems/challenges/hello-world/template.yaml`. The deployments table now shows the stack as `IN_PROGRESS`, then `READY`.

**Fallback.** While the stack is creating, walk the audience through `problems/challenges/hello-world/template.yaml`. It is one page of CFn — that **is** the demo.

## Step 6 — Open the Participant Portal, submit the flag, watch the score (≈ 1 min)

**Action.** Open the participant portal URL (also printed by `make deploy`), log in as the team, then:

1. Read the problem instructions: "Open AWS Console → SSM Parameter Store → `/<NamePrefix>/hello`, copy the value."
2. The participant clicks **Open AWS Console** (one-click SSO via federation → AssumeRole into the team's read-only `ParticipantViewerRole`).
3. They copy `Hello from <NamePrefix>` and paste it into the flag-submission box on the portal.
4. The scoreboard increments by **+100 pt**.

**What just happened.** The portal called the scoring Lambda (the generic dispatcher from ADR-012). The Lambda saw `kind: "flag"`, compared the submitted string against the stored answer, wrote a `ScoreEvent`, and re-emitted `ScoreUpdated` on the EventBridge bus. The scoreboard subscribed to that event and refreshed.

**Fallback.** If federation is not configured for the demo account, paste the flag value directly. The flag path does not require Console access — the Console SSO is a "wow" for the demo, not a requirement.

## Total run-time

| Segment                                       | Talking | Background        |
| --------------------------------------------- | ------- | ----------------- |
| Step 1 — clone & install                      | 30 s    | -                 |
| Step 2 — `make deploy`                        | 30 s    | ~10 min (live)    |
| Step 3 — create event                         | 1 min   | -                 |
| Step 4 — add problem                          | 1 min   | -                 |
| Step 5 — bulk deploy                          | 1 min   | ~2 min            |
| Step 6 — solve and score                      | 1 min   | -                 |
| **Total speaking**                            | ≈ 5 min |                   |

Background steps run while you talk. The longest live wait is Step 5 (~2 minutes), which is filled by reading the one-page CFn template aloud.

## Troubleshooting one-liners

| Symptom                                        | Fix                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `make install` is slow                         | First run only, subsequent runs hit the Bun cache.                             |
| `make deploy` says "credentials"               | Run `aws sso login` then retry. CDK uses the default profile chain.            |
| Problem catalog is empty in the console        | `git submodule update --init --recursive problems` and refresh the browser.    |
| CFn stack stays `CREATE_IN_PROGRESS`           | One of the rollout templates is waiting on a service quota; check CloudTrail.  |
| Flag submission returns 401                    | The portal Cognito セッション expired; sign out, sign back in, resubmit.             |
| Scoreboard does not refresh                    | Wait 5 seconds — the portal polls (no SSE, by design — see AGENTS.md).         |
| Want to tear it all down                       | `make destroy` (= `make lite-down`). Idempotent from partial-failure state.    |

## What to say at the close

- "That was a **single tenant** path. The same flow, behind SBT control-plane multi-tenancy, is `make deploy-saas` — three phases, 15 to 20 minutes, BASIC / STANDARD / PREMIUM tier pooling plus PLATINUM silo per tenant."
- "Problems ship as `metadata.json` + a one-page `template.yaml` + an optional `portal/` plugin. That is the contract — anyone can author one without touching the platform code (ADR-012)."
- "Apache 2.0. The platform is the host, the problems are the plugins. Add your own."

## Where to go next

- [`docs/demos/sales-pitch-15min.md`](./sales-pitch-15min.md) — same flow with pain-point talking points
- [`docs/demos/architecture-tour-30min.md`](./architecture-tour-30min.md) — under-the-hood walkthrough
- [`problems/README.md`](../../problems/README.md) — write your own problem
- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10-minute architecture overview
