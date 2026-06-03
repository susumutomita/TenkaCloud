# Disruption live-fire — observe a real cross-account fault + auto-revert

> 日本語: [disruption-live-fire.ja.md](./disruption-live-fire.ja.md)

| Attribute | Value |
|---|---|
| Audience | Operator validating the red-team disruption path on a real AWS account |
| When to use | Once per release, to prove the cross-account disruption chain ([#1419](https://github.com/susumutomita/TenkaCloud/issues/1419) / [#1666](https://github.com/susumutomita/TenkaCloud/issues/1666)) injects an **observable fault** that **auto-reverts** |
| Time | ~10 min (plus one team already deployed) |
| Output | An `evidence.json` showing `healthy → FAULTED → recovered`, plus the executor Lambda log + audit row |

The fire → inject → revert chain is fully implemented and unit-tested with mocked SDKs (operator fire → EventBridge → executor Lambda → `AssumeRole` with `ExternalId` into the competitor account → SSM `RunCommand` → scheduled revert). A mock cannot prove the chain lands a fault in a **real** stack and reverts in time. This runbook does, and captures the evidence that closes #1419/#1666.

## Prerequisites

| # | Requirement |
|---|---|
| 1 | Platform deployed (`make deploy-saas`, or Lite `make deploy`) with the `ProblemDeployBackendStack` disruption executor Lambda + EventBridge rule live |
| 2 | One team has **security-battle-royale** deployed into its competitor account (the `competitor-bootstrap.yaml` role is rolled out, `ExternalId` set via `CDK_PARAM_DEPLOY_EXTERNAL_ID`) |
| 3 | The team's app is reachable: note `Ec2HostHint` from the deployment's stack outputs — the health URL is `http://<Ec2HostHint>:8080/api/v1/apistatus` |
| 4 | An **operator** bearer token (Cognito JWT with `TenantAdmin` or `TenantOperator` role) — copy it from the Application Admin Console in browser dev-tools (a request's `authorization` header) |

The default target disruption is **`availability-flood`** (`ssm-run-command`): a bounded HTTP flood from the team's own EC2 against `localhost` saturates the single Flask process for ~30s, so the `uptime-multi` scorer sees the slots fail; the scheduled revert (`afterSeconds: 90`) kills any stray load (ADR-029 INV-2 — no disruption is permanent).

## Step 1 — inspect the exact request (no AWS, no token)

```bash
bun run scripts/disruption-live-fire.ts --dry-run \
  --api https://<event-api-id>.execute-api.<region>.amazonaws.com \
  --event <eventId> --team <teamId> \
  --app-url http://<Ec2HostHint>:8080/api/v1/apistatus
```

It prints the exact `POST /events/<eventId>/disruptions/fire` body it would send. Eyeball it against your intent before any live call. (The request builder mirrors `DisruptionFireRequestSchema` and is unit-tested.)

## Step 2 — fire and capture evidence

```bash
export DISRUPTION_JWT='<operator-bearer-token>'
bun run scripts/disruption-live-fire.ts \
  --api https://<event-api-id>.execute-api.<region>.amazonaws.com \
  --event <eventId> --team <teamId> \
  --app-url http://<Ec2HostHint>:8080/api/v1/apistatus \
  --evidence evidence.json
```

The script: probes the baseline (aborts unless healthy) → fires → polls the health URL every 5s for 180s → judges the timeline → writes `evidence.json`.

Equivalent manual fire if you prefer `curl` (the script automates exactly this):

```bash
curl -X POST "https://<event-api-id>.execute-api.<region>.amazonaws.com/events/<eventId>/disruptions/fire" \
  -H "authorization: Bearer $DISRUPTION_JWT" -H "content-type: application/json" \
  -d '{"problemId":"security-battle-royale","disruptionId":"availability-flood","scope":"team","targetTeamIds":["<teamId>"],"requestId":"live-fire-0001abcd"}'
```

## Step 3 — read the verdict

| Verdict | Meaning | What it tells you |
|---|---|---|
| `PASS` | `healthy → FAULTED → recovered` within the window | The chain injected a real fault **and** auto-reverted — #1419/#1666 satisfied |
| `no-fault` | Never went unhealthy after the fire | The disruption did **not** reach the stack (check the executor Lambda log / the `ExternalId` trust / the `InstanceId` stack output) |
| `no-recovery` | Faulted but never recovered (or too slow) | Inject worked, revert did not — investigate the scheduled revert (ADR-029 INV-2) |
| `no-baseline` | Target already unhealthy before firing | Fix the deployment first; you can't attribute a fault to the fire |

## Evidence to keep

1. `evidence.json` — the sampled timeline + the verdict.
2. The **executor Lambda** CloudWatch log group (`disruption-executor`) around the fire time — shows the `AssumeRole` + `SendCommand` + the scheduled revert.
3. The **audit row**: `GET /events/<eventId>/disruptions/audit` returns the fired record (auditId, scope, affected teams).

Together these are the live proof that the technical disruptions inject a real, self-healing fault — not an audit-only no-op.
