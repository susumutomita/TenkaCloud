# Composite Runtime multicloud acceptance runbook

This runbook covers the live deployment and teardown acceptance for the Composite
Runtime across the four supported providers (AWS, GCP, Azure, Sakura). It pairs
two artifacts: an offline orchestration harness that CI runs on every PR, and an
env-guarded live runner a maintainer runs once with real credentials.

See the parent epic Composite Runtime (Issue 2058) and the live-acceptance task
(Issue 2081) for context.

## What ships here

| Artifact | Path | Runs in CI |
| --- | --- | --- |
| Offline orchestration harness | `composite-acceptance-harness.ts` | yes |
| Offline harness suite | `test/problem-deploy/composite-acceptance-harness.test.ts` | yes |
| Env-guarded live runner | `test/problem-deploy/composite-live-acceptance.test.ts` | skipped |
| This runbook | `infrastructure/lib/problem-deploy/handlers/acceptance/README.md` | n/a |

The offline harness composes the real, already-merged Composite modules (deploy
routing, materialization, ordered dispatch, status aggregation and
reconciliation, namespaced outputs, composite-probe scoring, teardown fan-out,
teardown completion). Only the provider transport (deploy adapter, connection
resolver, per-target teardown, HTTPS probe) and the persistence client are
in-memory doubles. No real cloud, no network, and no provider SDK credentials are
involved, so it is the portion of the acceptance task CI can verify (CI has no
cloud accounts and never deploys).

## How every provider participates in a Composite parent lifecycle

A Composite parent owns one coordination row plus N independent target rows. Each
target is a normal deployment row driven by its own provider transport. The four
fixture targets, in declared order, are:

| Ordinal | targetId | Provider | Engine | Entry |
| --- | --- | --- | --- | --- |
| 0 | aws-api | aws | cloudformation | aws/template.yaml |
| 1 | gcp-worker | gcp | infra-manager | gs://bucket/worker |
| 2 | azure-edge | azure | bicep | azure/main.bicep |
| 3 | sakura-service | sakura | apprun | sakura/service.json |

The lifecycle phases, each driven by the real module the harness composes:

1. Register and verify each per-team connection (`resolveCompositeTargetConnection`).
   AWS resolves a verified competitor account and returns identifiers only; GCP,
   Azure, and Sakura validate the per-team SecureString config structurally and
   return only the team slug.
2. Start the composite deploy (`startCompositeDeployment`): quota is enforced once
   per parent, the parent plus four target rows are materialized, then every
   target dispatches in declared order through its provider adapter.
3. Status progression: the parent aggregates from its targets, moving
   PENDING to IN_PROGRESS to COMPLETE (`reconcileCompositeParentDeployStatus`).
   Any FAILED target aggregates the parent to FAILED.
4. Outputs are collected under each targetId namespace, so identically named
   outputs across providers never collide (`collectCompositeOutputs`).
5. Composite scoring runs one HTTPS probe per target and awards full points only
   when every probe succeeds (`scoreCompositeProbe`).
6. Teardown fan-out flips the parent to DELETING and requests teardown for every
   eligible target (`requestCompositeTeardown`); teardown completion finalizes the
   parent to DELETED only once every target is deleted-like
   (`reconcileCompositeParentTeardown`).

## Failure-injection steps

The offline suite injects the four required failure classes and asserts that the
per-target failure reason stays visible, the parent state aggregates correctly,
and no secret leaks:

1. Connection preflight failure: one provider's resolver throws. The target is
   reported failed and retryable, with the error class name as the reason; the
   other three providers still pass.
2. Dispatch failure: one provider's deploy adapter throws on its turn. The target
   row becomes FAILED with a class-name-only reason, the other targets stay
   PENDING, the dispatch loop never short-circuits, and the parent aggregates to
   FAILED.
3. Mid-flight target status failure: a target turns FAILED after dispatch. The
   parent aggregates to FAILED and scoring is withheld until the parent is
   COMPLETE.
4. Teardown failure: one target's teardown transport throws. The fan-out still
   attempts every target, the failed target is reported failed, and the parent
   stays DELETING (never silently finalized to DELETED).

## Running the offline harness

```bash
cd infrastructure
bunx vitest run test/problem-deploy/composite-acceptance-harness.test.ts
```

## Running the live four-provider matrix (one-time maintainer step)

The live matrix needs real accounts for all four providers and is therefore a
one-time maintainer run, not a CI step. With no `TENKACLOUD_LIVE_ACCEPTANCE` env
var the live suite is skipped, so CI stays green.

```bash
cd infrastructure
TENKACLOUD_LIVE_ACCEPTANCE=1 \
TENKACLOUD_LIVE_AWS_ACCOUNT_ID=123456789012 \
TENKACLOUD_LIVE_GCP_PROJECT=my-gcp-project \
TENKACLOUD_LIVE_AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000 \
TENKACLOUD_LIVE_SAKURA_ZONE=is1a \
bunx vitest run test/problem-deploy/composite-live-acceptance.test.ts
```

Credential policy enforced by the live runner:

- GCP uses keyless Workload Identity Federation only. A static service-account
  JSON key (`TENKACLOUD_LIVE_GCP_SA_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS`
  pointing at a `.json` key file) is rejected.
- AWS uses the existing cross-account AssumeRole path; the External ID is always
  required and is read from SSM, never passed inline.
- No provider secret, token, or credential is written into a deployment record or
  a log. The live run reuses the redaction guarantee the offline harness proves.

## Evidence checklist

Capture the following from a live run and attach them to the acceptance record:

- Preflight: per-target connection verified, with provider request IDs redacted.
- Parent and target state timeline: PENDING, IN_PROGRESS, COMPLETE for the deploy
  phase, then DELETING and DELETED for teardown, with timestamps per transition.
- Scoring: the composite-probe result, the per-target probe outcomes, and the
  points awarded.
- Teardown verification: every target reached a deleted-like terminal state and
  the parent finalized to DELETED.
- Cost and cleanup: confirm no residual resources remain in any of the four
  accounts after teardown, and record the run's incremental cost.

## Cost and cleanup checklist

- Run the live matrix in throwaway or sandbox projects in each provider.
- Confirm teardown finalized the parent to DELETED and re-list resources in each
  account to verify nothing survived.
- Keep the resource footprint minimal; every fixture target is a small,
  short-lived deployment.

## Known limitations and follow-ups

- The live runner pins the matrix order and credential policy and is the place a
  maintainer wires the real adapter, credential, probe, and teardown transports
  for the one-time run; until that wiring is in, enabling the env var fails loudly
  rather than silently passing.
- CI never exercises a real provider; the offline harness is the regression gate,
  and the live matrix is a periodic maintainer verification.
- Provider request IDs must be redacted by the caller when capturing evidence;
  the modules under test never emit them.
