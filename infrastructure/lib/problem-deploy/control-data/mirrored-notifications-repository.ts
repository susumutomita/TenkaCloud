/**
 * [Issue #2527 Slice 3] Mirror (DynamoDB-canonical + SQL-replica) adapter for the
 * notifications aggregate — extracted verbatim from the former all-aggregate
 * `mirrored-repositories.ts`, which now re-exports this class as a barrel.
 * Mirror policy: writes commit to canonical first and reach the replica only on
 * a successful canonical outcome; reads/cursors are canonical-only unless the
 * class documents read-repair; a replica failure throws (fail loud).
 */

import type { NotificationRecord, NotificationsPage, NotificationsRepository } from "./types.js";

export class MirroredNotificationsRepository implements NotificationsRepository {
  constructor(
    private readonly canonical: NotificationsRepository,
    private readonly replica: NotificationsRepository,
  ) {}

  async append(record: NotificationRecord): Promise<void> {
    await this.canonical.append(record);
    await this.replica.append(record);
  }

  // [#2439] cursor は backend 固有 token のため read-repair せず canonical を返す(A3 と同じ)。
  async listByEvent(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<NotificationsPage> {
    return this.canonical.listByEvent(eventId, opts);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}
