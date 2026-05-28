# SOC2 evidence map — TenkaCloud

This document explains where each SOC2-relevant control's evidence lives, how an auditor or security team can extract it, the retention policy applied, and how tamper detection is structured. It assumes the platform is deployed in SaaS mode (= multi-tenant); the Lite mode picture is noted inline where it diverges.

This is a readiness map, not a certification statement. Full SOC2 Type II certification requires an external assessor; this document covers the controls TenkaCloud implements directly.

## Controls and evidence

| Control | Evidence source | How to extract | Retention | Tamper detection |
| --- | --- | --- | --- | --- |
| CC6.1 — Logical access (admin actions) | `AdminAuditLog` DynamoDB table (`PK=TENANT#…` / `PK=SYSTEM#<env>`) | `GET /admin/insight/audit?scope=…&from=&to=&principal=` returns paginated JSON; `GET /admin/insight/audit/export` returns CSV | 365 days in DDB when `AUDIT_RETENTION_DAYS=365` (default 90 for OSS) | DDB `RemovalPolicy=RETAIN` + same-row TTL only |
| CC6.3 — Authentication (sign-in audit) | CloudTrail `AWS_Cognito` events + `AdminAuditLog` row when admin operations succeed/fail | CloudWatch Logs Insights query on the SystemAuditWriter Lambda log group; combine with audit API for the admin-side outcome | CloudTrail: 90 days managed; AdminAuditLog: per CC6.1 | CloudTrail digest validation |
| CC6.6 — Privileged access change | `AdminAuditLog` rows with `action=patch_user_role` / `action=rotate_external_id` / `action=invite_user` | Same as CC6.1; filter by `action` | Same as CC6.1 | Same as CC6.1 |
| CC7.2 — Anomaly detection | Generic Scoring Lambda metrics + Lambda error logs | CloudWatch metrics namespace `TenkaCloud/*`; alarms wired in `observability-stack.ts` | CloudWatch metrics 15 months | CloudWatch immutable timestamps; alarm change history in CloudTrail |

## How an auditor extracts evidence

The audit team should be issued a temporary SystemAdmin Cognito account (see `scripts/provision-tenant.sh` for the pattern). With the SystemAdmin role attached:

1. **Pull the operational view (last 90 days)**.

   ```sh
   curl -H "Authorization: Bearer $JWT" \
     "$ADMIN_INSIGHT_API/admin/insight/audit?scope=system&from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z" \
     | jq .
   ```

2. **Export the operational view as CSV for the work paper**.

   ```sh
   curl -H "Authorization: Bearer $JWT" \
     "$ADMIN_INSIGHT_API/admin/insight/audit/export?scope=system&from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z" \
     -o audit-system-2026Q1.csv
   ```

## Retention policy

| Layer | Default | Enterprise / hosted | Maximum |
| --- | --- | --- | --- |
| `AdminAuditLog` DynamoDB TTL | 90 days | 365 days (env `AUDIT_RETENTION_DAYS=365`) | 3650 days (= 10-year clamp) |

The DDB TTL governs the operational window (= what the admin UI can paginate).

## Tamper detection

- **DynamoDB layer**. Writes are append-only by convention (no UPDATE / DELETE statements in any handler). The table itself uses `RemovalPolicy.RETAIN`, so even a stack delete does not drop rows. TTL expiry is the only sanctioned deletion path.
- **Read access**. Both export endpoints require an API Gateway JWT Authorizer (= ControlPlane Cognito UserPool) and the `cognito:groups ⊇ {SystemAdmin}` claim re-check in the Lambda handler. Tenant Admins receive `403 forbidden`.

## Known gaps and follow-ups

- **CloudTrail digest validation is not yet automated**. An auditor confirming Cognito sign-in events relies on standard AWS CloudTrail integrity hashes.
- **Cognito Advanced Security Features (= ASF) event ingestion** is deferred. ASF emits richer authentication failure data than standard CloudTrail.
- **External SIEM forwarding** (= Athena / OpenSearch / Splunk) is not configured.

## References

- `infrastructure/lib/problem-deploy/admin-audit-log-table.ts` — DDB schema.
- `infrastructure/lib/admin-insight/handlers/admin-insight-handler/index.ts` — `/admin/insight/audit` read + CSV export.
- `docs/architecture/adr-020-authorization-model.html` — admin audit log scope and role split.
