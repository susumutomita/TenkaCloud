/**
 * Issue #2294: control-plane reconciliation on Workers Cron.
 *
 * In Always-On mode the control plane runs on Workers, so event-status transitions
 * (and expired-data pruning) are driven by a Workers Cron trigger — NOT by a constant
 * AWS per-minute tick (that monolith belongs to SaaS/Lite mode). This keeps the platform
 * at zero always-on AWS compute between events. A status change becomes visible within one
 * Cron interval.
 */

/** How long after `ends_at` an ENDED event's row is pruned. */
export const ENDED_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ReconcileOutcome {
  readonly activated: number;
  readonly ended: number;
  readonly pruned: number;
}

/**
 * Transition event status by wall-clock time and prune long-ended events.
 *
 *  - `DRAFT`  → `ACTIVE` once `starts_at` has passed.
 *  - `ACTIVE` → `ENDED`  once `ends_at` has passed.
 *  - `ENDED`  rows whose `ends_at` is older than {@link ENDED_EVENT_RETENTION_MS} are deleted,
 *    together with their dependent rows (teams / checkpoints / submissions / score summary).
 *
 * Activation runs before ending so an event whose window has fully elapsed within one
 * interval lands in `ENDED` in a single pass. All times are ISO-8601 strings compared
 * lexically — safe because `Date#toISOString()` is fixed-width UTC.
 */
export async function reconcileEvents(db: D1Database, now: Date): Promise<ReconcileOutcome> {
  const nowIso = now.toISOString();
  const retentionCutoffIso = new Date(now.getTime() - ENDED_EVENT_RETENTION_MS).toISOString();

  const activated = await db
    .prepare(
      `UPDATE events SET status = 'ACTIVE', updated_at = ?
        WHERE status = 'DRAFT' AND starts_at IS NOT NULL AND starts_at <= ?`,
    )
    .bind(nowIso, nowIso)
    .run();

  const ended = await db
    .prepare(
      `UPDATE events SET status = 'ENDED', updated_at = ?
        WHERE status = 'ACTIVE' AND ends_at IS NOT NULL AND ends_at <= ?`,
    )
    .bind(nowIso, nowIso)
    .run();

  // Prune long-ended events. Dependent rows key off event_id; delete children first so no
  // orphan rows survive (D1 does not enforce the FKs by default).
  const expiredEventIds = await db
    .prepare(
      `SELECT event_id FROM events
        WHERE status = 'ENDED' AND ends_at IS NOT NULL AND ends_at <= ?`,
    )
    .bind(retentionCutoffIso)
    .all<{ event_id: string }>();

  let pruned = 0;
  for (const { event_id: eventId } of expiredEventIds.results) {
    await db.batch([
      db.prepare("DELETE FROM submissions WHERE event_id = ?").bind(eventId),
      db.prepare("DELETE FROM score_summary WHERE event_id = ?").bind(eventId),
      db.prepare("DELETE FROM challenge_checkpoints WHERE event_id = ?").bind(eventId),
      db.prepare("DELETE FROM teams WHERE event_id = ?").bind(eventId),
      db.prepare("DELETE FROM events WHERE event_id = ?").bind(eventId),
    ]);
    pruned += 1;
  }

  return {
    activated: activated.meta.changes,
    ended: ended.meta.changes,
    pruned,
  };
}
