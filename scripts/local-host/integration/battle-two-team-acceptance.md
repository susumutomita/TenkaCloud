# Two-team Battle acceptance design

Status: design and Host boundary regressions only. **No real VM result.**
Base: TenkaCloud `744e8caec66d1b0fa260622c2f6fc39feffe01c3`.
Tracking: [Simulator Battle work](https://github.com/susumutomita/TenkaCloudSimulator/pull/465).

## Reuse, not a second driver

Extend `simulator-battle.ts`, which already starts the managed Simulator and real
Host, deploys the catalog problem through HTTP, registers participant endpoints,
reads production scores, operates the guest terminal and tears down the event.
It currently creates one team and manually restarts nginx. Its successful run
would not establish two-team isolation or the 600-second automatic revert.
Do not use the Simulator Python rehearsal's stand-in Host/scoring as evidence.
Do not change the original Hello World Battle template or its UserData.

Reuse `startManagedSimulator`, `connectSimulatorHosting`, `startLocalHost`, the
existing terminal client and the official Simulator bundle builder. Runtime,
IAM, database schemas and authentication remain outside this test-only work.

## Stop before claiming two-team separation

The current Host connection has one Simulator endpoint and one account identity.
Separate team IDs, stack names and guest instance IDs within that endpoint do
not prove separate Simulator processes, databases or operator-token authorities.
The acceptance harness must record those ownership boundaries without recording
secret values. A two-team API regression can pass while this stronger requirement
remains unsatisfied.

Before a live two-team run, decide and implement the production routing contract
for two independently owned Simulator process/DB/token authorities under one
Host event. The driver must not implement its own hidden routing, create two
unrelated Host events and call that one event, or replace production adapters
with fakes. Until production routing supports this, report the process/DB/token
lane as blocked, not passed. This design does not grant permission to implement
that runtime change or move to another environment to evade restrictions.

## Live sequence and evidence

1. **Preflight:** require an existing compatible binary, QEMU and qualified
   bundle, built Host interfaces and explicitly selected immutable Challenge
   catalog. Record binary/source revisions, catalog/template and bundle hashes,
   OS/architecture and the Host clock domain. Preserve originals. No downloads,
   installation, real AWS fallback or relaxed proxy/loopback guards in the driver.
2. **Initialize:** use one organizer login to create alpha and beta in one event,
   with distinct participant keys, jobs and native resource ownership. Deploy
   both via `/events/:eventId/deploy`. Wait for both COMPLETE jobs, fail on either
   FAILED job, and do not seed jobs, readiness or scores in the live database.
3. **Operate:** each participant reads `/portal/me` and explicitly registers its
   frontend and API URLs. Require own job/instance outputs. Exercise both guest
   terminals using their issued handoffs. Try alpha's key against beta's job ID
   and vice versa; require 403 and no issued terminal code. Check foreign endpoint
   registration and foreign credential/resource use are denied by the actual
   authority. Do not infer this from hostnames or a request returning HTTP 200.
4. **Grade:** start the event and observe nonzero scores for both teams from the
   production Host. Keep per-team, per-slot observations and production scoring
   events. Never calculate replacement scores or alter the Host clock/tick.
5. **Targeted disruption:** POST `frontend-down` with `scope: "team"`,
   `targetTeamIds: [alphaTeamId]` and one request ID. On an ambiguous reply read
   that request's audit; never blindly repeat injection. Observe the alpha-owned
   execution, failed frontend health and production penalty. Beta must remain
   healthy and continue scoring during the same window; total-score comparison
   alone cannot distinguish a healthy API slot from a failed frontend slot.
6. **Automatic recovery:** observe the production execution's `revertAt` and
   its configured 600-second delay, then wait on wall time with a bounded
   tolerance. Do not call the revert API, restart nginx, fast-forward timers or
   substitute a successful SSM return for guest health. Require the recorded
   revert command completion, restored alpha frontend and renewed Host points.
   `revert_command_completed` alone explicitly does not attest frontend health.
7. **Cleanup:** delete alpha's deployment first; require its seal/terminal
   revocation, deleted native resources and released guest handles while beta
   remains accessible. Delete the event and require completed teardown for both.
   Stop owned Host/Simulator processes and verify their exit/owned resources.
   Record cleanup failure separately even when the primary scenario also fails.

Every phase has a bounded deadline. Unknown health, missing evidence, timeout,
partial cleanup and unsupported two-authority routing fail the corresponding
lane. Keep a sanitized report with exact source identities and failed phase.
Do not emit tokens, participant keys, cookies, terminal codes or raw transcripts.
Remove only owned temporary paths after verified cleanup; do not erase retained
failure state while describing cleanup as complete.

## Independent checks in this change

`tests/simulator-battle-host.test.ts` uses the real HostingService/HostStore with
fake AWS/Battle adapters. Three additional regressions check bidirectional
foreign-job terminal denial before any adapter call, readiness isolation, and
single-team teardown preserving the other team's access. They deliberately use
the same simulated account, so account equality cannot mask a missing team check.

These tests do not deploy VMs, exercise native IAM, establish separate authorities,
run a browser, wait 600 seconds or prove scoring/recovery. They are independent
Host boundary checks, not acceptance-driver or live VM passes. Full VM execution
remains opt-in rehearsal under the repository rules, not a new merge gate.

## Next bounded implementation

First supply and test the production two-authority routing seam in its own
explicitly owned scope. Then extend the existing driver with an optional two-team
mode, per-team maps (never index `[0]` as the only deployment), status-aware
negative HTTP checks and audit polling. Keep its original one-team mode intact.
Add independent tests of timeout, ambiguous injection response, partial setup and
cleanup-failure behavior before running it against qualified real VM resources.
