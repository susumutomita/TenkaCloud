# Always-On Control Plane

This directory tracks the operator runbook for ADR-049 Phase 3. The executable
Worker is in `apps/always-on-control-plane`.

## Implemented in the Phase 3 foundation

- Hono Worker with separate organizer and participant authorization paths.
- Auth0 access-token validation using remote JWKS, fixed `RS256`, issuer, and
  audience checks.
- Auth0 Organization (`org_id`) to TenkaCloud `tenantId` projection.
- Per-request tenant suspension checks from the control database.
- D1 schema for events, teams, multiple challenge checkpoints, submissions, and
  materialized leaderboard rows.
- Team login keys stored and looked up only by SHA-256 hash.
- One-time team-key handoff, multi-checkpoint flag submission, idempotent
  scoring, and leaderboard reads.
- Environment-specific Wrangler configuration and a manually approved GitHub
  Actions deployment.

This is a foundation slice of issue #2292. SPA migration, Auth0 tenant
provisioning automation, sign-in Log Streams, live D1/Turso volume comparison,
and the DNS rollback exercise remain open.

## Reconciliation on Workers Cron (Phase 5, #2294)

In Always-On mode the control plane runs on Workers, so event-status transitions
and expired-data pruning are driven by a Workers Cron trigger
(`triggers.crons` in `wrangler.jsonc`, every 5 minutes) — not by a constant AWS
per-minute tick (that monolith belongs to SaaS/Lite mode). `reconcileEvents`
moves `DRAFT → ACTIVE` once `starts_at` passes and `ACTIVE → ENDED` once
`ends_at` passes, then prunes events ended longer ago than the 90-day retention
window (with their teams / checkpoints / submissions / score-summary rows).
This preserves ADR-014's freshness contract (a status change is visible within
one Cron interval) while keeping the platform at zero always-on AWS compute
between events.

Before that prune deletes a long-ended event, an organizer can archive its
control-store scoring snapshot via `GET /v1/admin/events/{eventId}/export`
(organizer-role gated and tenant-scoped). It returns `scoreSummary`,
`runtimeScores`, and `submissions`. Per-tick Battle score events remain in the
AWS event runtime and require a separate archive export.

## Phase 3 gate verification (2026-07-03)

| Gate | Verified result | Status |
| --- | --- | --- |
| Auth0 MAU | The official B2B pricing page lists 25,000 monthly active users and five Organizations on Free. | Confirmed |
| Auth0 role model | The same comparison table excludes Role Management from Free; B2B Essentials lists role-based access control per Organization. The issue's Auth0 RBAC design therefore requires a paid plan or an explicit move to application-owned role claims. | Decision required |
| Cloudflare commercial use | The current Self-Serve Subscription Agreement grants an organization the right to use the Services and does not impose a blanket non-commercial-use restriction. It does prohibit reselling access, bypassing quotas, and several regulated uses. This engineering review is not legal advice. | Confirmed for implementation |
| Event-month capacity | Workers Paid has a $5 USD monthly minimum. Free is limited to 100,000 requests/day and 10 ms CPU/invocation, so running an event on Free is unsupported. | Confirmed |
| D1 versus Turso | Resolved as a role split, not a single choice (ADR-049 §16/§17): D1 is the Always-On control store (this Worker); Turso stays the Lambda-era (SaaS/Lite) control-data bridge. Neither store's production read/write volume or cross-region latency has been measured against a live workload yet. | Role split decided; live volume/latency measurement still open |

The Lambda-era side of that split now has a pure-SQL mode, not just the
mirrored bridge: setting `CDK_PARAM_CONTROL_DATA_BACKEND=turso` on a
problem-deploy-backend deploy (ADR-049 §5.1, issue #2435,
[`infrastructure/lib/problem-deploy/control-data/`](../../infrastructure/lib/problem-deploy/control-data/))
makes CDK skip synthesizing the SaaS/Lite control-data DynamoDB tables
entirely — zero standing capacity on that path — while this Always-On Worker
keeps D1 regardless of that flag, per the §16 role split above. See
[CLAUDE.md](../../CLAUDE.md#data-isolation) for the full table list and the
current live-verification caveat (implemented and unit/synth-tested, not yet
exercised as a live deploy against a real Turso database).

Sources:

- [Auth0 pricing](https://auth0.com/pricing)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/)

## Local verification

```sh
bun install
cd apps/always-on-control-plane
bun run types
bun run typecheck
bun run test
bun run test:coverage
bun run build
bunx wrangler check startup
```

The tests run inside `workerd` with a local D1 binding and apply the committed
migration before execution.

## Cloudflare bootstrap

Wrangler automatic provisioning is enabled by omitting the D1 resource ID.
Before the first environment deployment:

1. Replace the Auth0 placeholders in `wrangler.jsonc`.
2. Run `bun run deploy --env staging` from the Worker directory. Wrangler
   creates the environment-specific D1 database and writes its ID to the config.
3. Apply migrations with
   `bunx wrangler d1 migrations apply CONTROL_DB --env staging --remote`.
4. Commit the generated non-secret D1 resource IDs.
5. Repeat for production only after staging acceptance.

Do not put Auth0 client secrets or Cloudflare tokens in `wrangler.jsonc`.
Deployment uses the repository/environment secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Signed intent issuance (Phase 4)

`POST /v1/admin/events/:eventId/deploy-intents` lets a mutating organizer role
mint a JWS-signed `CloudActionIntent` (`action: "deploy" | "destroy"`) and relay
it to the AWS intent-ingress Function URL. The intent carries identifiers only;
`ExternalId` and other cross-account secrets stay on the AWS side. Configuration
per environment:

- `INTENT_INGRESS_URL` (var): the Function URL emitted by the
  `tenkacloud-intent-ingress` stack (`make deploy-always-on-ingress`).
- `INTENT_AUDIENCE` (var): must equal the ingress
  `CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE` value when that check is enabled.
- `INTENT_SIGNING_PRIVATE_JWK` (secret): the ES256 private JWK. Set it with
  `bunx wrangler secret put INTENT_SIGNING_PRIVATE_JWK --env production`.

### Signing key (ES256)

Generate a P-256 keypair with Node 20+ WebCrypto. Keep the generated private JWK
out of the repository and shell history:

```sh
KEYPAIR_JSON="$(
  node --input-type=module <<'NODE'
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
console.log(JSON.stringify({
  privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
}));
NODE
)"
PRIVATE_JWK="$(printf '%s' "$KEYPAIR_JSON" | jq -c .privateJwk)"
PUBLIC_JWK="$(printf '%s' "$KEYPAIR_JSON" | jq -c .publicJwk)"
printf '%s' "$PRIVATE_JWK" |
  bunx wrangler secret put INTENT_SIGNING_PRIVATE_JWK --env production
aws ssm put-parameter \
  --name "$CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM" \
  --type String \
  --value "$PUBLIC_JWK" \
  --overwrite
unset KEYPAIR_JSON PRIVATE_JWK PUBLIC_JWK
```

The public JWK is intentionally stored as an SSM `String`, not `SecureString`;
the ingress Lambda receives its parameter name through
`CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM`. The private JWK exists only
as the Cloudflare Worker secret. Trust-bridge ES256 supports a `kid` protected
header for key selection when a keyed resolver is used.

For rotation, publish the new public JWK to SSM, roll
`INTENT_SIGNING_PRIVATE_JWK` to the matching private JWK, verify ingress, and
then retire the old key material. HS256 verification through
`CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM` remains available for rollback
and other trust-bridge consumers; do not remove that SecureString during this
migration.

The Worker validates the command shape against the frozen deploy detail contract
(problem slug, 12-digit AWS account, region; shared patterns exported by
trust-bridge), confirms the team belongs to the organizer's tenant and event,
and returns `202` with `requestId` and `deploymentId`. For a deploy the two are
equal and become the `jobId` the ingress re-emits; keep the `deploymentId` — a
destroy command must send it back so the delete targets the same deployment
identity. An ingress 4xx (the command itself was rejected, e.g. an unknown
problem) surfaces as `422` with the ingress' stable reason code; an ingress 5xx
or an unreachable ingress surfaces as `502`.

## Event-month plan runbook

1. At least seven days before an event, enable Workers Paid for the Cloudflare
   account. Budget a minimum of $5 USD for that calendar month.
2. Record the active plan in the event readiness evidence and verify that the
   production Worker, D1 database, and custom domain belong to that account.
3. Run the staging smoke test and expected-concurrency load test before changing
   DNS. Do not open participant access while the account remains on Free.
4. During the event, monitor request count, errors, CPU time, and D1
   read/write/storage usage. Treat quota or billing-plan warnings as an
   operational incident.
5. After the event and its writeup window, stop participant polling before any
   downgrade. Retain D1 and the previous Worker version through the rollback
   window.

## Auth0 contract

Configure a Custom API for the `AUTH0_AUDIENCE`, using `RS256`. Organizer access
tokens must contain:

- `org_id`: Auth0 Organization ID.
- `https://tenkacloud.dev/roles`: an array containing `TenantAdmin`,
  `TenantOperator`, or `TenantViewer`.

The Worker does not trust a suspension claim from the token. Onboard or update
the `tenant_auth_projection` row (Auth0 Organization → tenant, plus the
suspension flag) through the system endpoint whenever organization membership or
suspension state changes:

```http
PUT /v1/system/tenant-auth-projections/{orgId}
Authorization: Bearer <SYSTEM_ADMIN_TOKEN>
Content-Type: application/json

{ "tenantId": "tenant-example", "suspended": false }
```

`SYSTEM_ADMIN_TOKEN` is a Workers secret
(`bunx wrangler secret put SYSTEM_ADMIN_TOKEN --env <environment>`), distinct
from any tenant/organizer credential. `suspended: true` revokes access
immediately — the middleware re-checks the projection on every request, so an
already-signed-in organizer is denied on the next call. The raw SQL below is an
equivalent break-glass fallback.

The current middleware accepts the namespaced role claim independently of how
Auth0 creates it. Before production, choose and document one supported source:

- Auth0 B2B Essentials (or higher) with per-Organization RBAC; or
- an application-owned authorization projection emitted by an Auth0 Action,
  with its lifecycle, audit, and revocation behavior reviewed separately.

Free-plan Role Management must not be assumed.

```sql
INSERT INTO tenant_auth_projection (org_id, tenant_id, suspended, updated_at)
VALUES ('org_example', 'tenant-example', 0, '2026-07-03T00:00:00.000Z')
ON CONFLICT(org_id) DO UPDATE SET
  tenant_id = excluded.tenant_id,
  suspended = excluded.suspended,
  updated_at = excluded.updated_at;
```

The SPA-facing `/runtime-config.json` retains runtime configuration outside the
application bundle and reports the Auth0 issuer, audience, and public client ID.

## Score feed (Phase 5, #2294)

Battle (uptime-kind) scoring runs in the AWS event runtime, while flag scoring
runs on the Worker. The runtime pushes each team's authoritative uptime points
into the control store so the leaderboard sums both:

```http
POST /v1/runtime/events/{eventId}/score-summaries
Authorization: Bearer <RUNTIME_FEED_TOKEN>
Content-Type: application/json

{ "scores": [ { "teamId": "…", "points": 120 } ] }
```

`RUNTIME_FEED_TOKEN` is a Workers secret
(`bunx wrangler secret put RUNTIME_FEED_TOKEN --env <environment>`), distinct
from the organizer and system-admin credentials. The leaderboard reads
`score_summary.score + runtime_score.points`, so an empty `runtime_score`
reduces to the flag-only leaderboard. The AWS-side producer (the uptime scoring
that calls this endpoint) runs in each per-event runtime stack on a one-minute
EventBridge schedule. It scans only that stack's immutable `eventId` scope,
dispatches Battle kinds (`uptime-*`, `phased-polling`, and
`attack-detection`), and posts one authoritative total per team. Flag kinds
remain on Workers.

Configure these GitHub Environment variables for the
`deploy-always-on-runtime` / `destroy-always-on-runtime` workflows:

- `ALWAYS_ON_DEPLOYMENTS_TABLE_NAME`
- `ALWAYS_ON_EVENTS_TABLE_NAME`
- `ALWAYS_ON_ENDPOINTS_TABLE_NAME`
- `ALWAYS_ON_CONTROL_PLANE_URL`
- `ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER` (SSM SecureString parameter name)
- `ALWAYS_ON_ARCHIVE_BUCKET_NAME` (existing private S3 bucket)
- optional `ALWAYS_ON_DISRUPTIONS_TABLE_NAME` and `ALWAYS_ON_EVENT_BUS_NAME`

The feed bearer is fetched with decryption at invocation time and is never put
in Lambda environment variables or workflow logs. The runtime schedule and
Lambda are deleted with the event stack, so there is no AWS tick between
events.

The destroy workflow invokes the event stack's archive Lambda before
CloudFormation deletion. It exports only that event's raw DynamoDB `EVENT#`
score rows as bounded JSONL parts under
`events/{eventId}/score-events/runs/{archiveId}/`, then atomically publishes
`events/{eventId}/score-events/latest.json`. A failed export stops teardown so
the runtime data remains available for retry.

The cleanup sweeper script (`infrastructure/lib/always-on-runtime/sweeper/`,
run manually — the nightly scheduled workflow was removed because its AWS OIDC
environment was never provisioned; re-add it at GA #2294) uses the same GitHub
OIDC role as runtime lifecycle workflows. Redeploy `tenkacloud-always-on-oidc`
after upgrading: its direct AWS SDK permissions allow account-wide
`DescribeStacks` (CloudFormation does not offer a resource-scoped list form),
while `DeleteStack` and `lambda:InvokeFunction` remain restricted to
`tenkacloud-event-runtime-*` resources.

## Rollback

The Worker deployment is versioned by Cloudflare. Application rollback is
`wrangler rollback`; traffic rollback is a DNS/API-origin switch back to the
existing CloudFront/API Gateway path. Do not delete the D1 database during the
compatibility window. A live rollback drill is still required before #2292 can
close.
