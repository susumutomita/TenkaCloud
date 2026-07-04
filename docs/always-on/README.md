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

## Phase 3 gate verification (2026-07-03)

| Gate | Verified result | Status |
| --- | --- | --- |
| Auth0 MAU | The official B2B pricing page lists 25,000 monthly active users and five Organizations on Free. | Confirmed |
| Auth0 role model | The same comparison table excludes Role Management from Free; B2B Essentials lists role-based access control per Organization. The issue's Auth0 RBAC design therefore requires a paid plan or an explicit move to application-owned role claims. | Decision required |
| Cloudflare commercial use | The current Self-Serve Subscription Agreement grants an organization the right to use the Services and does not impose a blanket non-commercial-use restriction. It does prohibit reselling access, bypassing quotas, and several regulated uses. This engineering review is not legal advice. | Confirmed for implementation |
| Event-month capacity | Workers Paid has a $5 USD monthly minimum. Free is limited to 100,000 requests/day and 10 ms CPU/invocation, so running an event on Free is unsupported. | Confirmed |
| D1 versus Turso | The repository now has a D1 implementation, but production read/write volume and cross-region latency have not been measured. | Open |

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
- `INTENT_SIGNING_SECRET` (secret): set with
  `bunx wrangler secret put INTENT_SIGNING_SECRET --env production`. Trust-bridge
  JWS is HS256 in Phase 1, so this value must equal the SSM SecureString the
  ingress reads through `CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM`. Rotate by
  writing the new value to SSM first, then updating the Workers secret.

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

The Worker does not trust a suspension claim from the token. Seed or update the
`tenant_auth_projection` row whenever organization membership or suspension
state changes:

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

## Rollback

The Worker deployment is versioned by Cloudflare. Application rollback is
`wrangler rollback`; traffic rollback is a DNS/API-origin switch back to the
existing CloudFront/API Gateway path. Do not delete the D1 database during the
compatibility window. A live rollback drill is still required before #2292 can
close.
