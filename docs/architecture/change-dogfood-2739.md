# `/change` dogfood record — Issue #2739

## Framing

- **Issue:** pure-Turso scheduled deploy and teardown remained permanently dormant.
- **Outcome required:** enable scheduled actions on the SQL backend without weakening DynamoDB's staged-enablement guard.
- **Trust boundary:** the reconciler may publish deploy/delete events only after backend selection, schedule/status/idempotency checks, and least-privilege EventBridge wiring are all evidenced.
- **Physical impact expectation:** Lambda code only; no new resource or IAM action.

## Approach registry

| Family | Hypothesis | Expected evidence | Evidence obtained | Exact remaining gap | Status |
| --- | --- | --- | --- | --- | --- |
| Backend-aware builder guard | Table-name environment variables are required only by the DynamoDB repository, so Turso can require only bus/environment plus catalog for deploy. | `selectBackend` branch, Turso resources with empty table placeholders, DynamoDB missing-table behavior unchanged. | Builder tests, reconciler integration, pure-Turso synth assertions, full CI. | Live short-lived event verification after deployment. | selected |
| Inject synthetic table names on Turso | Keeping the old universal guard could work if CDK injected placeholder names. | No DDB calls use those names and no confusing IAM/table contract is introduced. | Repository resolvers showed placeholders are ignored only on SQL, but synth injection would falsely advertise tables and blur the physical model. | None; approach contradicted the zero-table contract. | disproved |
| Remove table guards for every backend | A single reduced guard could enable both backends. | DynamoDB would still fail safely before any scheduled action when table wiring is incomplete. | Existing staged-enablement tests demonstrated DynamoDB intentionally depends on all table names and grants. | Would regress the #1910 dormant-until-wired contract. | disproved |
| Move schedule execution into a separate SQL-only Lambda | Backend-specific scheduling could avoid conditional builders. | Lower coupling without duplicate clocks, permissions, reconciliation, or deployment topology. | Architecture review found it would duplicate the one-minute reconciler and create ordering/retry drift. | Large new topology with no product benefit. | blocked |

## Dynamic reallocation

The initial investigation split into independent source-of-truth checks:

1. runtime/backend selection and repository resolution;
2. scheduled builder guards;
3. reconciler idempotency and status gates;
4. CDK environment and IAM output.

After the repository and synth checks both supported the backend-aware guard, effort moved away from the separate-Lambda family and into adversarial tests for the selected path. The rejected families were retained above so a later maintainer can see why they should not be retried without new evidence.

## Adversarial and security review

The review attacked the selected approach on the following axes:

- **Accidental DynamoDB regression:** explicit DynamoDB tests keep missing table wiring dormant.
- **Unknown backend fallback:** `selectBackend` remains fail-loud.
- **Double fire:** existing `deployFiredAt` / `teardownFiredAt` and status transitions remain unchanged.
- **Over-broad IAM:** pure Turso already had bus-scoped `events:PutEvents`; no new action or wildcard was added.
- **Raw table access:** deploy, teardown, event, team, competitor-account, and deployment access were traced through injected repository seams.
- **Physical drift:** Turso synth still contains no control-data DynamoDB tables or table-name environment variables.

No unresolved high-severity security or trust-boundary finding remained. The live environment check was explicitly retained as operational evidence rather than represented as unit-test proof.

## Completion evidence

- PR #2742 implemented the selected approach.
- Architecture harness, formatting, typecheck, build, and all three coverage shards passed.
- PR #2742 was squash-merged and automatically closed Issue #2739.
- Regression analysis and physical impact were recorded in the PR body.

## Reuse guidance

A blocked or disproved family should be retried only when its exact gap changes. Examples include a future removal of the DynamoDB backend, a new schedule ownership model, or repository seams that no longer ignore table-name placeholders on pure SQL.
