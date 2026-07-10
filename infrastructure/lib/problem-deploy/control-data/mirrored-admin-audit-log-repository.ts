/**
 * [Issue #2527 Slice 3] Mirror (DynamoDB-canonical + SQL-replica) adapter for the
 * admin-audit-log aggregate — extracted verbatim from the former all-aggregate
 * `mirrored-repositories.ts`, which now re-exports this class as a barrel.
 * Mirror policy: writes commit to canonical first and reach the replica only on
 * a successful canonical outcome; reads/cursors are canonical-only unless the
 * class documents read-repair; a replica failure throws (fail loud).
 */

import type { AdminAuditLogPage, AdminAuditLogRepository, AdminAuditRow } from "./types.js";

/**
 * DynamoDB-primary/SQL-replica equivalent for the AdminAuditLog aggregate (Issue #2442 / Phase
 * C4). Writes go to canonical then replica (best-effort ordering matches every other Mirrored
 * class in this file); reads (`listPage` / `listAllByPartition`) pass through to canonical DDB —
 * cursor formats and page boundaries are backend-specific, same rationale as every other Mirrored
 * read in this file.
 */
export class MirroredAdminAuditLogRepository implements AdminAuditLogRepository {
  constructor(
    private readonly canonical: AdminAuditLogRepository,
    private readonly replica: AdminAuditLogRepository,
  ) {}

  async appendAudit(row: AdminAuditRow): Promise<void> {
    await this.canonical.appendAudit(row);
    await this.replica.appendAudit(row);
  }

  listPage(
    pk: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<AdminAuditLogPage> {
    return this.canonical.listPage(pk, opts);
  }

  listAllByPartition(
    pk: string,
    opts: { readonly pageSize: number; readonly maxPages: number },
  ): Promise<readonly AdminAuditRow[]> {
    return this.canonical.listAllByPartition(pk, opts);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}
