/**
 * [Problem Packs / Issue #2095] Event catalog-snapshot pinning + deployment
 * provenance.
 *
 * Split out of {@link ./pack-activation.ts} so each module owns ONE concern:
 * `pack-activation.ts` owns per-tenant activation and the tenant effective
 * catalog, and this module owns the IMMUTABLE event pin and the deployment
 * provenance resolved from it.
 *
 *   - {@link createEventSnapshot} records, at event-creation time, a
 *     `catalogSnapshotId` plus the resolved per-problem provenance (pack
 *     id/version/digest, or core). It composes the tenant's effective catalog and
 *     fails closed on a duplicate problem id / unavailable runtime / unsatisfied
 *     core range — the same fail-closed rules as activation.
 *   - {@link EventSnapshotStore} persists pins append-only and REFUSES to
 *     overwrite an existing event id, so a later deactivate / install / activate
 *     can never rewrite an event's catalog (immutability of the pin).
 *   - {@link resolveDeploymentProvenance} resolves a problem's source identity
 *     from its EVENT's snapshot, never from the live catalog.
 *
 * Determinism + purity: `catalogSnapshotId` is a deterministic digest of the
 * pinned provenance, so equal pins yield an equal id independent of wall-clock
 * time; the store does only LOCAL filesystem I/O and parses the on-disk records
 * with Zod so malformed state fails loudly.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  CoreProblemInput,
  EffectiveCatalogEntry,
  EffectiveCatalogProvenance,
  PackSnapshotInput,
  PlatformContext,
} from "./effective-catalog.js";
import { composeTenantEffectiveCatalog } from "./pack-activation.js";

/** The event-pin file at the root of a snapshot store. Records pinned events. */
export const EVENT_SNAPSHOTS_FILENAME = "pack-event-snapshots.json";

/** One pinned problem's resolved provenance within an event snapshot. */
export interface PinnedProblemProvenance {
  readonly problemId: string;
  readonly provenance: EffectiveCatalogProvenance;
}

/** An immutable catalog pin recorded at event creation. */
export interface EventSnapshot {
  /** Deterministic digest of the pinned provenance set — the catalog snapshot id. */
  readonly catalogSnapshotId: string;
  readonly eventId: string;
  readonly tenantId: string;
  /** Resolved provenance per problem id, in stable problem-id order. */
  readonly problems: readonly PinnedProblemProvenance[];
}

/** Stable failure reasons for {@link createEventSnapshot}. */
export type CreateEventFailureReason =
  | "DUPLICATE_PROBLEM_ID"
  | "RUNTIME_UNAVAILABLE"
  | "CORE_RANGE_UNSATISFIED";

/** Discriminated result of {@link createEventSnapshot}. Never throws on a known failure. */
export type CreateEventResult =
  | { readonly ok: true; readonly snapshot: EventSnapshot }
  | { readonly ok: false; readonly reason: CreateEventFailureReason; readonly message: string };

/**
 * Compute the deterministic catalog snapshot id over the pinned provenance set.
 * Equal pins yield an equal id regardless of wall-clock time, so the pin is
 * reproducible.
 */
export function computeCatalogSnapshotId(
  tenantId: string,
  problems: readonly PinnedProblemProvenance[],
): string {
  const canonical = JSON.stringify({
    tenantId,
    problems: [...problems]
      .sort((a, b) => a.problemId.localeCompare(b.problemId))
      .map((p) => ({ problemId: p.problemId, provenance: p.provenance })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Pin a catalog snapshot to an event at creation time. Composes the tenant's
 * effective catalog (core + its active pack revisions), fails closed on a
 * duplicate problem id / unavailable runtime / unsatisfied core range, and on
 * success records the resolved per-problem provenance plus a deterministic
 * `catalogSnapshotId`. The returned snapshot is immutable: callers persist it and
 * resolve deployments against it, so later deactivate / install operations never
 * change this event's catalog.
 */
export function createEventSnapshot(input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly core: readonly CoreProblemInput[];
  readonly activePacks: readonly PackSnapshotInput[];
  readonly platform: PlatformContext;
}): CreateEventResult {
  const composed = composeTenantEffectiveCatalog({
    core: input.core,
    activePacks: input.activePacks,
    platform: input.platform,
  });
  if (!composed.ok) {
    return { ok: false, reason: composed.reason, message: composed.message };
  }
  const problems = toPinnedProvenance(composed.entries);
  const catalogSnapshotId = computeCatalogSnapshotId(input.tenantId, problems);
  return {
    ok: true,
    snapshot: {
      catalogSnapshotId,
      eventId: input.eventId,
      tenantId: input.tenantId,
      problems,
    },
  };
}

function toPinnedProvenance(
  entries: readonly EffectiveCatalogEntry[],
): readonly PinnedProblemProvenance[] {
  return [...entries]
    .sort((a, b) => a.problemId.localeCompare(b.problemId))
    .map((entry) => ({ problemId: entry.problemId, provenance: entry.provenance }));
}

/**
 * Resolve a problem's source provenance from an EVENT's pinned snapshot, never
 * from the live catalog. Returns undefined when the problem id is not part of the
 * pinned event, so a deployment can never silently bind to an unpinned problem.
 */
export function resolveDeploymentProvenance(
  snapshot: EventSnapshot,
  problemId: string,
): EffectiveCatalogProvenance | undefined {
  return snapshot.problems.find((p) => p.problemId === problemId)?.provenance;
}

const EffectiveCatalogProvenanceSchema = z.union([
  z.object({ source: z.literal("core") }).strict(),
  z
    .object({
      source: z.literal("pack"),
      packId: z.string().min(1),
      packVersion: z.string().min(1),
      contentDigest: z.string().min(1),
    })
    .strict(),
]);

const EventSnapshotSchema = z
  .object({
    catalogSnapshotId: z.string().min(1),
    eventId: z.string().min(1),
    tenantId: z.string().min(1),
    problems: z.array(
      z
        .object({
          problemId: z.string().min(1),
          provenance: EffectiveCatalogProvenanceSchema,
        })
        .strict(),
    ),
  })
  .strict();

const EventSnapshotFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(EventSnapshotSchema),
  })
  .strict();

/**
 * Append-only, immutable store of event catalog pins over the snapshot store. An
 * event's pin is written ONCE; {@link EventSnapshotStore.put} refuses to overwrite
 * an existing event id, so a later deactivate / install can never rewrite an
 * event's catalog. Only local filesystem I/O, Zod-validated at the boundary.
 */
export class EventSnapshotStore {
  private readonly storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = path.resolve(storeDir);
  }

  /** Persist a new event pin. Refuses (throws) to overwrite an existing event id. */
  put(snapshot: EventSnapshot): void {
    const events = this.read();
    if (events.some((e) => e.eventId === snapshot.eventId)) {
      throw new Error(
        `Event '${snapshot.eventId}' is already pinned. An event's catalog snapshot is immutable and cannot be overwritten.`,
      );
    }
    this.write([...events, snapshot]);
  }

  /** The pinned snapshot for an event id, or undefined when none is pinned. */
  get(eventId: string): EventSnapshot | undefined {
    return this.read().find((e) => e.eventId === eventId);
  }

  /** All pinned events, in stable event-id order. */
  list(): readonly EventSnapshot[] {
    return this.read();
  }

  private read(): EventSnapshot[] {
    const file = path.join(this.storeDir, EVENT_SNAPSHOTS_FILENAME);
    if (!fs.existsSync(file)) return [];
    const parsed = EventSnapshotFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
    return [...parsed.events].sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  private write(events: readonly EventSnapshot[]): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const sorted = [...events].sort((a, b) => a.eventId.localeCompare(b.eventId));
    const file = path.join(this.storeDir, EVENT_SNAPSHOTS_FILENAME);
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, events: sorted }, null, 2)}\n`);
  }
}
