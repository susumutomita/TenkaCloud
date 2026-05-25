# SOC2 evidence map — TenkaCloud

Status: Phase 3 (Issue #1341 / #1335). This document explains where each SOC2-relevant control's evidence lives, how an auditor or security team can extract it, the retention policy applied, and how tamper detection is structured. It assumes the platform is deployed in SaaS mode (= multi-tenant); the Lite mode picture is noted inline where it diverges.

This is a readiness map, not a certification statement. Full SOC2 Type II certification requires an external assessor; this document covers the controls TenkaCloud implements directly.

## Controls and evidence

| Control | Evidence source | How to extract | Retention | Tamper detection |
| --- | --- | --- | --- | --- |
| CC6.1 — Logical access (admin actions) | `AdminAuditLog` DynamoDB table (`PK=TENANT#…` / `PK=SYSTEM#<env>`) | `GET /admin/insight/audit?scope=…&from=&to=&principal=` returns paginated JSON; `GET /admin/insight/audit/export` returns CSV | 365 days in DDB when `AUDIT_RETENTION_DAYS=365` (default 90 for OSS) | DDB `RemovalPolicy=RETAIN` + same-row TTL only; mirrored to immutable S3 (see CC6.2) |
| CC6.2 — Append-only audit (immutability) | `tenkacloud-audit-archive-*` S3 bucket | `GET /admin/audit/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=jsonl` streams JSONL from the immutable archive | Object Lock Compliance mode, 1-year minimum retention; lifecycle moves objects to Glacier after 90 days and deletes them after 7 years | S3 Object Lock Compliance mode (= admin and root cannot overwrite or shorten retention); bucket versioning enforced; SSL-only access policy |
| CC6.3 — Authentication (sign-in audit) | CloudTrail `AWS_Cognito` events + `AdminAuditLog` row when admin operations succeed/fail | CloudWatch Logs Insights query on the SystemAuditWriter Lambda log group; combine with audit API for the admin-side outcome | CloudTrail: 90 days managed; AdminAuditLog: per the bucket above | CloudTrail digest validation + S3 Object Lock on archive bucket |
| CC6.6 — Privileged access change | `AdminAuditLog` rows with `action=patch_user_role` / `action=rotate_external_id` / `action=invite_user` | Same as CC6.1; filter by `action` | Same as CC6.1/CC6.2 | Same as CC6.2 (every admin write is mirrored into Object Lock storage by the DDB Stream → Lambda → S3 path) |
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

3. **Extract the immutable archive (= longer horizon, JSONL)**.

   ```sh
   curl -H "Authorization: Bearer $JWT" \
     "$ADMIN_INSIGHT_API/admin/audit/export?from=2025-05-01&to=2026-05-01&format=jsonl" \
     -o audit-archive-2025-2026.jsonl
   ```

   The response is hard-capped at 100 MB per request. The header `x-export-truncated: true` indicates the auditor needs to issue further requests with narrower date ranges. `x-export-object-count` and `x-export-bytes` report what was actually returned.

4. **Cross-check the archive integrity in the AWS console**.

   - Open the `tenkacloud-audit-archive-<account>` bucket.
   - Confirm "Object Lock" is enabled and the default retention mode is `Compliance` with 365-day retention.
   - Pick one object; confirm its retention policy applies and that the "Edit retention" UI rejects a shortening attempt with an `AccessDenied` (even when called as root).

## Retention policy

| Layer | Default | Enterprise / hosted | Maximum |
| --- | --- | --- | --- |
| `AdminAuditLog` DynamoDB TTL | 90 days | 365 days (env `AUDIT_RETENTION_DAYS=365`) | 3650 days (= 10-year clamp) |
| S3 archive Object Lock minimum | 365 days (Compliance mode) | 365 days | Bucket-level constant; cannot be shortened post-creation |
| S3 archive lifecycle Glacier transition | 90 days | 90 days | Constant |
| S3 archive lifecycle expiration | 7 years (2555 days) | 7 years | Constant |

The DDB TTL governs the operational window (= what the admin UI can paginate). The archive governs the audit window (= what is provable after the operational window expires).

## Tamper detection

- **DynamoDB layer**. Writes are append-only by convention (no UPDATE / DELETE statements in any handler). The table itself uses `RemovalPolicy.RETAIN`, so even a stack delete does not drop rows. TTL expiry is the only sanctioned deletion path.
- **DynamoDB Streams**. The table emits a `NEW_IMAGE` stream into the `AuditArchiveWriter` Lambda for every INSERT. MODIFY and REMOVE records are explicitly skipped, so TTL expiry never reaches the archive — only true admin writes are mirrored.
- **S3 Object Lock (Compliance mode)**. Once the writer Lambda `PutObject`s an audit row, the object is immutable for the retention period (= 365 days). Compliance mode rejects retention shortening attempts from any IAM identity, including the AWS account root. Versioning is enforced as the Object Lock prerequisite.
- **Bucket policy**. `enforceSSL: true` adds a `Deny` statement against `aws:SecureTransport=false`, so audit objects can only be read over TLS.
- **Public access**. `BlockPublicAccess.BLOCK_ALL` denies any public ACL or policy from being added even by a future operator. The archive bucket can only be read by the IAM principal granted via `grantRead` on the `AdminInsightApiLambda`.
- **Read access**. The export endpoint requires both an API Gateway JWT Authorizer (= ControlPlane Cognito UserPool) and the `cognito:groups ⊇ {SystemAdmin}` claim re-check in the Lambda handler. Tenant Admins receive `403 forbidden` before any S3 call is issued.

## Known gaps and follow-ups

- **CloudTrail digest validation is not yet automated**. An auditor confirming Cognito sign-in events relies on standard AWS CloudTrail integrity hashes; we do not yet copy CloudTrail digests into the archive bucket. Tracked as a deferred item under #1335.
- **Cognito Advanced Security Features (= ASF) event ingestion** is deferred. ASF emits richer authentication failure data than standard CloudTrail; wiring that into the same archive is planned but not in scope for this Phase 3 evidence map.
- **External SIEM forwarding** (= Athena / OpenSearch / Splunk) is not configured. Auditors that need full-text query across the 7-year horizon should ingest the archive bucket into their SIEM directly (= the JSONL layout is Hive-partitioned by `year=`/`month=`/`day=`, so Athena `MSCK REPAIR TABLE` works out of the box).

## References

- `infrastructure/lib/problem-deploy/admin-audit-log-table.ts` — DDB schema and stream configuration.
- `infrastructure/lib/problem-deploy/audit-archive-bucket.ts` — S3 Object Lock bucket and writer Lambda construct.
- `infrastructure/lib/problem-deploy/handlers/audit-archive-writer/index.ts` — DDB Stream → S3 JSONL conversion.
- `infrastructure/lib/admin-insight/handlers/admin-insight-handler/audit-export-s3.ts` — `/admin/audit/export` export logic.
- `docs/architecture/adr-020-authorization-model.html` — admin audit log scope and role split.
